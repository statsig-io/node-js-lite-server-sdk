import { ConfigSpec } from './ConfigSpec';
import Diagnostics, {
  ActionType,
  ContextType,
  KeyType,
  MAX_SAMPLING_RATE,
  StepType,
} from './Diagnostics';
import { StatsigLocalModeNetworkError } from './Errors';
import { EvaluationReason } from './EvaluationReason';
import { DataAdapterKey, IDataAdapter } from './interfaces/IDataAdapter';
import OutputLogger from './OutputLogger';
import {
  ExplicitStatsigOptions,
  InitStrategy,
  LoggerInterface,
} from './StatsigOptions';
import { poll } from './utils/core';
import IDListUtil, { IDList } from './utils/IDListUtil';
import safeFetch from './utils/safeFetch';
import StatsigFetcher from './utils/StatsigFetcher';
const { getStatsigMetadata } = require('./utils/core');

const SYNC_OUTDATED_MAX = 120 * 1000;

export type ConfigStore = {
  gates: Record<string, ConfigSpec>;
  configs: Record<string, ConfigSpec>;
  idLists: Record<string, IDList>;
  layers: Record<string, ConfigSpec>;
  experimentToLayer: Record<string, string>;
};

export type DiagnosticsSamplingRate = {
  dcs: number;
  log: number;
  idlist: number;
  initialize: number;
};

export const DEFAULT_API = 'https://statsigapi.net/v1';
const DEFAULT_API_FOR_DOWNLOAD_CONFIG_SPECS = 'https://api.statsigcdn.com/v1';

export type SDKConstants = DiagnosticsSamplingRate;

export default class SpecStore {
  private initReason: EvaluationReason;

  private api: string | null;
  private apiForDownloadConfigSpecs: string | null;
  private rulesUpdatedCallback: ((rules: string, time: number) => void) | null;
  private initialUpdateTime: number;
  private lastUpdateTime: number;
  private store: ConfigStore;
  private syncInterval: number;
  private idListSyncInterval: number;
  private disableRulesetsSync: boolean;
  private disableIdListsSync: boolean;
  private initialized: boolean;
  private syncTimer: NodeJS.Timeout | null;
  private idListsSyncTimer: NodeJS.Timeout | null;
  private fetcher: StatsigFetcher;
  private dataAdapter: IDataAdapter | null;
  private syncFailureCount: number = 0;
  private syncTimerLastActiveTime: number = Date.now();
  private idListsSyncTimerLastActiveTime: number = Date.now();
  private diagnostics: Diagnostics;
  private bootstrapValues: string | null;
  private initStrategyForIDLists: InitStrategy;
  private samplingRates: SDKConstants = {
    dcs: 0,
    log: 0,
    idlist: 0,
    initialize: MAX_SAMPLING_RATE,
  };
  private outputLogger = OutputLogger.getLogger();
  private sdkKey: string;

  public constructor(
    sdkKey: string,
    fetcher: StatsigFetcher,
    options: ExplicitStatsigOptions,
    diagnostics: Diagnostics,
  ) {
    this.fetcher = fetcher;
    this.api = options.api;
    this.apiForDownloadConfigSpecs = options.apiForDownloadConfigSpecs;
    this.rulesUpdatedCallback = options.rulesUpdatedCallback ?? null;
    this.lastUpdateTime = 0;
    this.initialUpdateTime = 0;
    this.store = {
      gates: {},
      configs: {},
      idLists: {},
      layers: {},
      experimentToLayer: {},
    };
    this.syncInterval = options.rulesetsSyncIntervalMs;
    this.idListSyncInterval = options.idListsSyncIntervalMs;
    this.disableRulesetsSync = options.disableRulesetsSync;
    this.disableIdListsSync = options.disableIdListsSync;
    this.initialized = false;
    this.syncTimer = null;
    this.idListsSyncTimer = null;
    this.dataAdapter = options.dataAdapter;
    this.initReason = 'Uninitialized';
    this.diagnostics = diagnostics;
    this.bootstrapValues = options.bootstrapValues;
    this.initStrategyForIDLists = options.initStrategyForIDLists;
    this.sdkKey = sdkKey;
  }

  public getInitReason() {
    return this.initReason;
  }

  public getInitialUpdateTime() {
    return this.initialUpdateTime;
  }

  public getLastUpdateTime() {
    return this.lastUpdateTime;
  }

  public getGate(gateName: string): ConfigSpec | null {
    return this.store.gates[gateName] ?? null;
  }

  public getConfig(configName: string): ConfigSpec | null {
    return this.store.configs[configName] ?? null;
  }

  public getLayer(layerName: string): ConfigSpec | null {
    return this.store.layers[layerName] ?? null;
  }

  public getExperimentLayer(experimentName: string): string | null {
    return this.store.experimentToLayer[experimentName] ?? null;
  }

  public getIDList(listName: string): IDList | null {
    return this.store.idLists[listName] ?? null;
  }

  public getAllGates(): Record<string, ConfigSpec> {
    return this.store.gates;
  }

  public getAllConfigs(): Record<string, ConfigSpec> {
    return this.store.configs;
  }

  public getAllLayers(): Record<string, ConfigSpec> {
    return this.store.layers;
  }

  public async init(): Promise<void> {
    var specsJSON = null;
    if (this.bootstrapValues != null) {
      if (this.dataAdapter != null) {
        this.outputLogger.error(
          'statsigSDK::initialize> Conflict between bootstrap and adapter. Defaulting to adapter.',
        );
      } else {
        try {
          this.addDiagnosticsMarker('bootstrap', 'start', { step: 'process' });
          if (this.syncBootstrapValues(this.bootstrapValues)) {
            this.initReason = 'Bootstrap';
          }
          this.setInitialUpdateTime();
        } catch (e) {
          this.outputLogger.error(
            'statsigSDK::initialize> the provided bootstrapValues is not a valid JSON string.',
          );
        }

        this.addDiagnosticsMarker('bootstrap', 'end', {
          step: 'process',
          value: this.initReason === 'Bootstrap',
        });
      }
    }

    const adapter = this.dataAdapter;
    if (adapter) {
      await adapter.initialize();
    }

    // If the provided bootstrapValues can be used to bootstrap the SDK rulesets, then we don't
    // need to wait for syncValues() to finish before returning.
    if (this.initReason === 'Bootstrap') {
      if (!this.disableRulesetsSync) {
        this.syncValues();
      }
    } else {
      if (adapter) {
        await this._fetchConfigSpecsFromAdapter();
      }
      if (this.lastUpdateTime === 0) {
        await this.syncValues(true);
      }

      this.setInitialUpdateTime();
    }
    if (this.initStrategyForIDLists === 'lazy') {
      setTimeout(async () => {
        await this._initIDLists();
      }, 0);
    } else if (this.initStrategyForIDLists !== 'none') {
      await this._initIDLists();
    }

    this.pollForUpdates();
    this.initialized = true;
  }

  private async _initIDLists(): Promise<void> {
    const adapter = this.dataAdapter;
    if (adapter) {
      const success = await this.syncIdListsFromDataAdapter();
      if (!success) {
        await this.syncIdListsFromNetwork();
      }
    } else {
      await this.syncIdListsFromNetwork();
    }
  }

  public resetSyncTimerIfExited(): Error | null {
    const syncTimerInactive =
      this.syncTimerLastActiveTime <
      Date.now() - Math.max(SYNC_OUTDATED_MAX, this.syncInterval);
    const idListsSyncTimerInactive =
      this.idListsSyncTimerLastActiveTime <
      Date.now() - Math.max(SYNC_OUTDATED_MAX, this.idListSyncInterval);
    if (
      (!syncTimerInactive || this.disableRulesetsSync) &&
      (!idListsSyncTimerInactive || this.disableIdListsSync)
    ) {
      return null;
    }
    let message = '';
    if (syncTimerInactive && !this.disableRulesetsSync) {
      this.clearSyncTimer();
      this.syncValues();
      message = message.concat(
        `Force reset sync timer. Last update time: ${
          this.syncTimerLastActiveTime
        }, now: ${Date.now()}`,
      );
    }
    if (idListsSyncTimerInactive && !this.disableIdListsSync) {
      this.clearIdListsSyncTimer();
      this.syncIdLists();
      message = message.concat(
        `Force reset id list sync timer. Last update time: ${
          this.idListsSyncTimerLastActiveTime
        }, now: ${Date.now()}`,
      );
    }
    this.pollForUpdates();
    return new Error(message);
  }

  public isServingChecks() {
    return this.lastUpdateTime !== 0;
  }

  private getResponseCodeFromError(e: unknown): number | undefined {
    if (!(e instanceof Error)) {
      return undefined;
    }
    const arr = e.message.split(' ');
    const statusString = arr.length === 0 ? undefined : arr[arr.length - 1];
    const status = parseInt(statusString ?? 'NaN');
    return isNaN(status) ? undefined : status;
  }

  private async _fetchConfigSpecsFromServer(): Promise<void> {
    this.addDiagnosticsMarker('download_config_specs', 'start', {
      step: 'network_request',
    });
    let response: Response | undefined = undefined;
    let error: Error | undefined = undefined;
    try {
      const path =
        '/download_config_specs' +
        `/${this.sdkKey}.json` +
        `?sinceTime=${this.lastUpdateTime}`;
      const url =
        (this.apiForDownloadConfigSpecs ??
          this.api ??
          DEFAULT_API_FOR_DOWNLOAD_CONFIG_SPECS) + path;
      response = await this.fetcher.get(url);
    } catch (e) {
      error = e as Error;
    } finally {
      const status = response
        ? response.status
        : this.getResponseCodeFromError(error);
      this.addDiagnosticsMarker('download_config_specs', 'end', {
        step: 'network_request',
        value: status ?? false,
      });
      if (error) {
        throw error;
      }
      if (!response) {
        return;
      }
    }

    this.addDiagnosticsMarker('download_config_specs', 'start', {
      step: 'process',
    });
    const specsString = await response.text();
    const processResult = this._process(JSON.parse(specsString));
    if (!processResult) {
      this.addDiagnosticsMarker('download_config_specs', 'end', {
        step: 'process',
        value: false,
      });
      return;
    }
    this.initReason = 'Network';
    if (
      this.rulesUpdatedCallback != null &&
      typeof this.rulesUpdatedCallback === 'function'
    ) {
      this.rulesUpdatedCallback(specsString, this.lastUpdateTime);
    }
    this._saveConfigSpecsToAdapter(specsString);
    this.addDiagnosticsMarker('download_config_specs', 'end', {
      step: 'process',
      value: this.initReason === 'Network',
    });
  }

  private async _fetchConfigSpecsFromAdapter(): Promise<void> {
    if (!this.dataAdapter) {
      return;
    }
    const { result, error, time } = await this.dataAdapter.get(
      DataAdapterKey.Rulesets,
    );
    if (result && !error) {
      const configSpecs =
        typeof result === 'string' ? JSON.parse(result) : result;
      if (this._process(configSpecs)) {
        this.initReason = 'DataAdapter';
      }
    }
  }

  private async _saveConfigSpecsToAdapter(specString: string): Promise<void> {
    if (!this.dataAdapter) {
      return;
    }
    await this.dataAdapter.set(
      DataAdapterKey.Rulesets,
      specString,
      this.lastUpdateTime,
    );
  }

  private pollForUpdates() {
    if (this.syncTimer == null && !this.disableRulesetsSync) {
      this.syncTimer = poll(async () => {
        this.syncTimerLastActiveTime = Date.now();
        await this.syncValues();
      }, this.syncInterval);
    }

    if (this.idListsSyncTimer == null && !this.disableIdListsSync) {
      this.idListsSyncTimer = poll(async () => {
        this.idListsSyncTimerLastActiveTime = Date.now();
        await this.syncIdLists();
      }, this.idListSyncInterval);
    }
  }

  private addDiagnosticsMarker(
    key: KeyType,
    action: ActionType,
    optionalArgs?: {
      step?: StepType;
      value?: string | number | boolean;
      metadata?: Record<string, string | number | boolean>;
    },
  ) {
    const { step, value, metadata } = optionalArgs ?? {};
    const context = this.initialized ? 'config_sync' : 'initialize';
    this.diagnostics.mark(context, key, action, step, value, metadata);
  }

  private logDiagnostics(
    context: ContextType,
    type: 'id_list' | 'config_spec',
  ) {
    if (this.initialized && context === 'config_sync') {
      this.diagnostics.logDiagnostics('config_sync', {
        type,
        samplingRates: this.samplingRates,
      });
    } else if (this.initialized && context === 'initialize') {
      this.diagnostics.logDiagnostics('initialize', {
        type: 'initialize',
        samplingRates: this.samplingRates,
      });
    }
  }

  public syncBootstrapValues(bootstrapValues: string): boolean {
    const specsJSON = JSON.parse(bootstrapValues);
    return this._process(specsJSON);
  }

  public async syncValues(isColdStart: boolean = false): Promise<void> {
    const adapter = this.dataAdapter;
    const shouldSyncFromAdapter =
      adapter?.supportsPollingUpdatesFor?.(DataAdapterKey.Rulesets) === true;

    try {
      if (shouldSyncFromAdapter) {
        await this._fetchConfigSpecsFromAdapter();
      } else {
        await this._fetchConfigSpecsFromServer();
      }
      this.syncFailureCount = 0;
    } catch (e) {
      this.syncFailureCount++;
      if (!(e instanceof StatsigLocalModeNetworkError)) {
        if (isColdStart) {
          this.outputLogger.error(
            'statsigSDK::initialize> Failed to initialize from the network.  See https://docs.statsig.com/messages/serverSDKConnection for more information',
          );
        } else if (
          this.syncFailureCount * this.syncInterval >
          SYNC_OUTDATED_MAX
        ) {
          this.outputLogger.warn(
            `statsigSDK::sync> Syncing the server SDK with ${
              shouldSyncFromAdapter ? 'the data adapter' : 'statsig'
            } has failed for  ${
              this.syncFailureCount * this.syncInterval
            }ms.  Your sdk will continue to serve gate/config/experiment definitions as of the last successful sync.  See https://docs.statsig.com/messages/serverSDKConnection for more information`,
          );
          this.syncFailureCount = 0;
        }
      }
    } finally {
      this.logDiagnostics('config_sync', 'config_spec');
    }
  }

  public async syncIdLists(): Promise<void> {
    if (this.initStrategyForIDLists === 'none') {
      return;
    }

    const adapter = this.dataAdapter;
    const shouldSyncFromAdapter =
      adapter?.supportsPollingUpdatesFor?.(DataAdapterKey.IDLists) === true;
    if (shouldSyncFromAdapter) {
      await this.syncIdListsFromDataAdapter();
    } else {
      await this.syncIdListsFromNetwork();
    }
    this.logDiagnostics('config_sync', 'id_list');
  }

  private updateSamplingRates(obj: any) {
    if (!obj || typeof obj !== 'object') {
      return;
    }
    this.safeSet(this.samplingRates, 'dcs', obj['dcs']);
    this.safeSet(this.samplingRates, 'idlist', obj['idlist']);
    this.safeSet(this.samplingRates, 'initialize', obj['initialize']);
    this.safeSet(this.samplingRates, 'log', obj['log']);
  }

  private safeSet(
    samplingRates: DiagnosticsSamplingRate,
    key: keyof DiagnosticsSamplingRate,
    value: unknown,
  ) {
    if (typeof value !== 'number') {
      return;
    }
    if (value < 0) {
      samplingRates[key] = 0;
    } else if (value > MAX_SAMPLING_RATE) {
      samplingRates[key] = MAX_SAMPLING_RATE;
    } else {
      samplingRates[key] = value;
    }
  }

  // returns a boolean indicating whether specsJSON has was successfully parsed
  private _process(specsJSON: Record<string, unknown>): boolean {
    if (!specsJSON?.has_updates) {
      return false;
    }

    if (
      specsJSON?.time !== undefined &&
      Number(specsJSON.time) < this.lastUpdateTime
    ) {
      return false;
    }

    const updatedGates: Record<string, ConfigSpec> = {};
    const updatedConfigs: Record<string, ConfigSpec> = {};
    const updatedLayers: Record<string, ConfigSpec> = {};
    const gateArray = specsJSON?.feature_gates;
    const configArray = specsJSON?.dynamic_configs;
    const layersArray = specsJSON?.layer_configs;
    const layerToExperimentMap = specsJSON?.layers;
    const samplingRates = specsJSON?.diagnostics;

    this.updateSamplingRates(samplingRates);

    if (
      !Array.isArray(gateArray) ||
      !Array.isArray(configArray) ||
      !Array.isArray(layersArray)
    ) {
      return false;
    }

    for (const gateJSON of gateArray) {
      try {
        const gate = new ConfigSpec(gateJSON);
        updatedGates[gate.name] = gate;
      } catch (e) {
        return false;
      }
    }

    for (const configJSON of configArray) {
      try {
        const config = new ConfigSpec(configJSON);
        updatedConfigs[config.name] = config;
      } catch (e) {
        return false;
      }
    }

    for (const layerJSON of layersArray) {
      try {
        const config = new ConfigSpec(layerJSON);
        updatedLayers[config.name] = config;
      } catch (e) {
        return false;
      }
    }

    const updatedExpToLayer: Record<string, string> =
      this._reverseLayerExperimentMapping(layerToExperimentMap);

    this.store.gates = updatedGates;
    this.store.configs = updatedConfigs;
    this.store.layers = updatedLayers;
    this.store.experimentToLayer = updatedExpToLayer;
    this.lastUpdateTime = (specsJSON.time as number) ?? this.lastUpdateTime;
    return true;
  }

  /**
   * Returns a reverse mapping of layers to experiment (or vice versa)
   */
  private _reverseLayerExperimentMapping(
    layersMapping: unknown,
  ): Record<string, string> {
    const reverseMapping: Record<string, string> = {};
    if (layersMapping != null && typeof layersMapping === 'object') {
      for (const [layerName, experiments] of Object.entries(
        // @ts-ignore
        layersMapping,
      )) {
        // @ts-ignore
        for (const experimentName of experiments) {
          // experiment -> layer is a 1:1 mapping
          reverseMapping[experimentName] = layerName;
        }
      }
    }
    return reverseMapping;
  }

  private async syncIdListsFromDataAdapter(): Promise<boolean> {
    try {
      const dataAdapter = this.dataAdapter;
      if (!dataAdapter) {
        return false;
      }
      const { result: adapterIdLists } = await dataAdapter.get(
        DataAdapterKey.IDLists,
      );
      if (!adapterIdLists) {
        return false;
      }
      const lookup = IDListUtil.parseBootstrapLookup(adapterIdLists);
      if (!lookup) {
        return false;
      }

      const tasks: Promise<void>[] = [];
      for (const name of lookup) {
        tasks.push(
          new Promise(async (resolve) => {
            const { result: data } = await dataAdapter.get(
              IDListUtil.getIdListDataStoreKey(name),
            );
            if (!data || typeof data !== 'string') {
              return;
            }

            this.store.idLists[name] = {
              ids: {},
              readBytes: 0,
              url: 'bootstrap',
              fileID: 'bootstrap',
              creationTime: 0,
            };

            IDListUtil.updateIdList(this.store.idLists, name, data);
            resolve();
          }),
        );
      }

      await Promise.all(tasks);
      return true;
    } catch {
      return false;
    }
  }

  private async syncIdListsFromNetwork(): Promise<void> {
    this.addDiagnosticsMarker('get_id_list_sources', 'start', {
      step: 'network_request',
    });
    let response = null;
    try {
      response = await this.fetcher.post(
        (this.api ?? DEFAULT_API) + '/get_id_lists',
        {
          statsigMetadata: getStatsigMetadata(),
        },
      );

      this.addDiagnosticsMarker('get_id_list_sources', 'end', {
        step: 'network_request',
        value: response.status,
      });
    } catch (e) {
      const status = this.getResponseCodeFromError(e);
      this.addDiagnosticsMarker('get_id_list_sources', 'end', {
        step: 'network_request',
        value: status ?? false,
      });
      this.outputLogger.warn(e as Error);
      return;
    }

    try {
      this.addDiagnosticsMarker('get_id_list_sources', 'start', {
        step: 'process',
      });
      const json = await response.json();
      const lookup = IDListUtil.parseLookupResponse(json);
      this.addDiagnosticsMarker('get_id_list_sources', 'end', {
        step: 'process',
      });
      if (!lookup) {
        return;
      }
      let promises = [];

      for (const [name, item] of Object.entries(lookup)) {
        const url = item.url;
        const fileID = item.fileID;
        const newCreationTime = item.creationTime;
        const oldCreationTime = this.store.idLists[name]?.creationTime ?? 0;
        if (
          typeof url !== 'string' ||
          newCreationTime < oldCreationTime ||
          typeof fileID !== 'string'
        ) {
          continue;
        }
        let newFile =
          fileID !== this.store.idLists[name]?.fileID &&
          newCreationTime >= oldCreationTime;

        if (
          (lookup.hasOwnProperty(name) &&
            !this.store.idLists.hasOwnProperty(name)) ||
          newFile // when fileID changes, we reset the whole list
        ) {
          this.store.idLists[name] = {
            ids: {},
            readBytes: 0,
            url,
            fileID,
            creationTime: newCreationTime,
          };
        }
        const fileSize = item.size ?? 0;
        const readSize = this.store.idLists[name].readBytes ?? 0;
        if (fileSize <= readSize) {
          continue;
        }
        promises.push(this.genFetchIDList(name, url, readSize));
      }

      IDListUtil.removeOldIdLists(this.store.idLists, lookup);

      await Promise.allSettled(promises);

      if (this.dataAdapter) {
        await IDListUtil.saveToDataAdapter(
          this.dataAdapter,
          this.store.idLists,
        );
      }
    } catch (e) {}
  }

  private async genFetchIDList(
    name: string,
    url: string,
    readSize: number,
  ): Promise<void> {
    try {
      this.addDiagnosticsMarker('get_id_list', 'start', {
        step: 'network_request',
        metadata: { url: url },
      });
      const res = await safeFetch(url, {
        method: 'GET',
        headers: {
          Range: `bytes=${readSize}-`,
        },
      });
      this.addDiagnosticsMarker('get_id_list', 'end', {
        step: 'network_request',
        value: res.status,
        metadata: { url: url },
      });
      this.addDiagnosticsMarker('get_id_list', 'start', {
        step: 'process',
        metadata: { url: url },
      });
      const contentLength = res.headers.get('content-length');
      if (contentLength == null) {
        throw new Error('Content-Length for the id list is invalid.');
      }
      const length = parseInt(contentLength);
      if (typeof length === 'number') {
        this.store.idLists[name].readBytes += length;
      } else {
        delete this.store.idLists[name];
        throw new Error('Content-Length for the id list is invalid.');
      }
      IDListUtil.updateIdList(this.store.idLists, name, await res.text());
      this.addDiagnosticsMarker('get_id_list', 'end', {
        step: 'process',
        value: true,
        metadata: { url: url },
      });
    } catch (e) {
      this.outputLogger.warn(e as Error);
      this.addDiagnosticsMarker('get_id_list', 'end', {
        step: 'process',
        value: false,
        metadata: { url: url },
      });
    }
  }

  public shutdown(): void {
    this.clearSyncTimer();
    this.clearIdListsSyncTimer();
    this.dataAdapter?.shutdown();
  }

  private clearSyncTimer(): void {
    if (this.syncTimer != null) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private clearIdListsSyncTimer(): void {
    if (this.idListsSyncTimer != null) {
      clearInterval(this.idListsSyncTimer);
      this.idListsSyncTimer = null;
    }
  }

  private setInitialUpdateTime() {
    this.initialUpdateTime =
      this.lastUpdateTime === 0 ? -1 : this.lastUpdateTime;
  }
}
