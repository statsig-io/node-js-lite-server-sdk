import ConfigEvaluation from './ConfigEvaluation';
import Diagnostics from './Diagnostics';
import DynamicConfig, { OnDefaultValueFallback } from './DynamicConfig';
import ErrorBoundary from './ErrorBoundary';
import {
  StatsigInvalidArgumentError,
  StatsigUninitializedError,
} from './Errors';
import Evaluator, { ClientInitializeResponse } from './Evaluator';
import {
  FeatureGate,
  makeEmptyFeatureGate,
  makeFeatureGate,
} from './FeatureGate';
import Layer from './Layer';
import LogEvent from './LogEvent';
import LogEventProcessor from './LogEventProcessor';
import OutputLogger from './OutputLogger';
import {
  ExplicitStatsigOptions,
  OptionsWithDefaults,
  StatsigOptions,
} from './StatsigOptions';
import { StatsigUser } from './StatsigUser';
import StatsigFetcher from './utils/StatsigFetcher';
import asyncify from './utils/asyncify';
import { getStatsigMetadata, isUserIdentifiable } from './utils/core';
import { HashingAlgorithm } from './utils/Hashing';

const MAX_VALUE_SIZE = 64;
const MAX_OBJ_SIZE = 2048;
const MAX_USER_SIZE = 2048;
let hasLoggedNoUserIdWarning = false;

enum ExposureLogging {
  Disabled = 'exposures_disabled',
  Enabled = 'exposures_enabled',
}

enum ExposureCause {
  Automatic = 'automatic_exposure',
  Manual = 'manual_exposure',
}

export type LogEventObject = {
  eventName: string;
  user: StatsigUser;
  value?: string | number | null;
  metadata?: Record<string, unknown> | null;
  time?: string | null;
};

export type ClientInitializeResponseOptions = {
  hash?: HashingAlgorithm;
};

/**
 * The global statsig class for interacting with gates, configs, experiments configured in the statsig developer console.  Also used for event logging to view in the statsig console, or for analyzing experiment impacts using pulse.
 */
export default class StatsigServer {
  private _pendingInitPromise: Promise<void> | null = null;
  private _ready: boolean = false;
  private _options: ExplicitStatsigOptions;
  private _logger: LogEventProcessor;
  private _secretKey: string;
  private _evaluator: Evaluator;
  private _fetcher: StatsigFetcher;
  private _errorBoundary: ErrorBoundary;
  private _diagnostics: Diagnostics;
  private outputLogger = OutputLogger.getLogger();

  public constructor(secretKey: string, options: StatsigOptions = {}) {
    this._secretKey = secretKey;
    this._options = OptionsWithDefaults(options);
    this._pendingInitPromise = null;
    this._ready = false;
    this._fetcher = new StatsigFetcher(this._secretKey, this._options);
    this._logger = new LogEventProcessor(this._fetcher, this._options);
    this._diagnostics = new Diagnostics({
      logger: this._logger,
      options: this._options,
    });
    this._evaluator = new Evaluator(
      this._secretKey,
      this._fetcher,
      this._options,
      this._diagnostics,
    );
    this._errorBoundary = new ErrorBoundary(secretKey);
  }

  /**
   * Initializes the statsig server SDK. This must be called before checking gates/configs or logging events.
   * @throws Error if a Server Secret Key is not provided
   */
  public initializeAsync(options: StatsigOptions = {}): Promise<void> {
    return this._errorBoundary.capture(
      () => {
        this._diagnostics.mark('initialize', 'overall', 'start');
        if (this._pendingInitPromise != null) {
          return this._pendingInitPromise;
        }

        if (this._ready === true) {
          if (options.allowReInitialize) {
            if (options.bootstrapValues) {
              this._evaluator.syncBootstrapValues(options.bootstrapValues);
            } else {
              return this._evaluator
                .syncStoreSpecs()
                .then((_) => this._evaluator.syncStoreIdLists());
            }
          }
          return Promise.resolve();
        }

        if (
          typeof this._secretKey !== 'string' ||
          this._secretKey.length === 0 ||
          !this._secretKey.startsWith('secret-')
        ) {
          return Promise.reject(
            new StatsigInvalidArgumentError(
              'Invalid key provided.  You must use a Server Secret Key from the Statsig console with the node-js-server-sdk',
            ),
          );
        }

        const initPromise = this._evaluator.init().finally(() => {
          this._ready = true;
          this._pendingInitPromise = null;
          this._diagnostics.mark(
            'initialize',
            'overall',
            'end',
            undefined,
            'success',
          );
          this._diagnostics.logDiagnostics('initialize');
        });
        if (
          this._options.initTimeoutMs != null &&
          this._options.initTimeoutMs > 0
        ) {
          this._pendingInitPromise = Promise.race([
            initPromise,
            new Promise((resolve) => {
              setTimeout(() => {
                this._diagnostics.mark(
                  'initialize',
                  'overall',
                  'end',
                  undefined,
                  'timeout',
                );
                this._diagnostics.logDiagnostics('initialize');
                this._ready = true;
                this._pendingInitPromise = null;
                resolve();
              }, this._options.initTimeoutMs);
            }) as Promise<void>,
          ]);
        } else {
          this._pendingInitPromise = initPromise;
        }
        return this._pendingInitPromise;
      },
      () => {
        this._ready = true;
        this._pendingInitPromise = null;
        return Promise.resolve();
      },
    );
  }

  // #region Check Gate

  /**
   * Check the value of a gate configured in the statsig console
   * @throws Error if initialize() was not called first
   * @throws Error if the gateName is not provided or not a non-empty string
   */
  public checkGateSync(user: StatsigUser, gateName: string): boolean {
    return this.getFeatureGateSync(user, gateName).value;
  }

  public getFeatureGateSync(user: StatsigUser, gateName: string): FeatureGate {
    return this._errorBoundary.capture(
      () => this.getGateImpl(user, gateName, ExposureLogging.Enabled),
      () => makeEmptyFeatureGate(gateName),
    );
  }

  public checkGateWithExposureLoggingDisabledSync(
    user: StatsigUser,
    gateName: string,
  ): boolean {
    return this.getFeatureGateWithExposureLoggingDisabledSync(user, gateName)
      .value;
  }

  public getFeatureGateWithExposureLoggingDisabledSync(
    user: StatsigUser,
    gateName: string,
  ): FeatureGate {
    return this._errorBoundary.capture(
      () => this.getGateImpl(user, gateName, ExposureLogging.Disabled),
      () => makeEmptyFeatureGate(gateName),
    );
  }

  public logGateExposure(user: StatsigUser, gateName: string) {
    const evaluation = this._evaluator.checkGate(user, gateName);
    this.logGateExposureImpl(user, gateName, evaluation, ExposureCause.Manual);
  }

  //#endregion

  // #region Get Config
  /**
   * Checks the value of a config for a given user
   */
  public getConfigSync(user: StatsigUser, configName: string): DynamicConfig {
    return this._errorBoundary.capture(
      () => this.getConfigImpl(user, configName, ExposureLogging.Enabled),
      () => new DynamicConfig(configName),
    );
  }

  public getConfigWithExposureLoggingDisabledSync(
    user: StatsigUser,
    configName: string,
  ): DynamicConfig {
    return this._errorBoundary.capture(
      () => this.getConfigImpl(user, configName, ExposureLogging.Disabled),
      () => new DynamicConfig(configName),
    );
  }

  public logConfigExposure(user: StatsigUser, configName: string) {
    const evaluation = this._evaluator.getConfig(user, configName);
    this.logConfigExposureImpl(
      user,
      configName,
      evaluation,
      ExposureCause.Manual,
    );
  }

  //#endregion

  // #region Get Experiment

  /**
   * Checks the value of a config for a given user
   * @throws Error if initialize() was not called first
   * @throws Error if the experimentName is not provided or not a non-empty string
   */
  public getExperimentSync(
    user: StatsigUser,
    experimentName: string,
  ): DynamicConfig {
    return this.getConfigSync(user, experimentName);
  }

  public getExperimentWithExposureLoggingDisabledSync(
    user: StatsigUser,
    experimentName: string,
  ): DynamicConfig {
    return this.getConfigWithExposureLoggingDisabledSync(user, experimentName);
  }

  public logExperimentExposure(user: StatsigUser, experimentName: string) {
    const evaluation = this._evaluator.getConfig(user, experimentName);
    this.logConfigExposureImpl(
      user,
      experimentName,
      evaluation,
      ExposureCause.Manual,
    );
  }

  //#endregion

  // #region Get Layer

  /**
   * Checks the value of a config for a given user
   * @throws Error if initialize() was not called first
   * @throws Error if the layerName is not provided or not a non-empty string
   */
  public getLayerSync(user: StatsigUser, layerName: string): Layer {
    return this._errorBoundary.capture(
      () => this.getLayerImpl(user, layerName, ExposureLogging.Enabled),
      () => new Layer(layerName),
    );
  }

  public getLayerWithExposureLoggingDisabledSync(
    user: StatsigUser,
    layerName: string,
  ): Layer {
    return this._errorBoundary.capture(
      () => this.getLayerImpl(user, layerName, ExposureLogging.Disabled),
      () => new Layer(layerName),
    );
  }

  public logLayerParameterExposure(
    user: StatsigUser,
    layerName: string,
    parameterName: string,
  ) {
    const evaluation = this._evaluator.getLayer(user, layerName);
    this.logLayerParameterExposureImpl(
      user,
      layerName,
      parameterName,
      evaluation,
      ExposureCause.Manual,
    );
  }

  //#endregion

  /**
   * Log an event for data analysis and alerting or to measure the impact of an experiment
   * @throws Error if initialize() was not called first
   */
  public logEvent(
    user: StatsigUser,
    eventName: string,
    value: string | number | null = null,
    metadata: Record<string, unknown> | null = null,
  ) {
    return this._errorBoundary.swallow(() =>
      this.logEventObject({
        eventName: eventName,
        user: user,
        value: value,
        metadata: metadata,
      }),
    );
  }

  public logEventObject(eventObject: LogEventObject) {
    return this._errorBoundary.swallow(() => {
      let eventName = eventObject.eventName;
      let user = eventObject.user ?? null;
      let value = eventObject.value ?? null;
      let metadata = eventObject.metadata ?? null;
      let time = eventObject.time ?? null;

      if (!(this._ready === true && this._logger != null)) {
        throw new StatsigUninitializedError();
      }
      if (typeof eventName !== 'string' || eventName.length === 0) {
        this.outputLogger.error(
          'statsigSDK::logEvent> Must provide a valid string for the eventName.',
        );
        return;
      }
      if (!isUserIdentifiable(user) && !hasLoggedNoUserIdWarning) {
        hasLoggedNoUserIdWarning = true;
        this.outputLogger.warn(
          'statsigSDK::logEvent> No valid userID was provided. Event will be logged but not associated with an identifiable user. This message is only logged once.',
        );
      }
      user = normalizeUser(user, this._options);
      if (shouldTrimParam(eventName, MAX_VALUE_SIZE)) {
        this.outputLogger.warn(
          'statsigSDK::logEvent> eventName is too long, trimming to ' +
            MAX_VALUE_SIZE +
            '.',
        );
        eventName = eventName.substring(0, MAX_VALUE_SIZE);
      }
      if (typeof value === 'string' && shouldTrimParam(value, MAX_VALUE_SIZE)) {
        this.outputLogger.warn(
          'statsigSDK::logEvent> value is too long, trimming to ' +
            MAX_VALUE_SIZE +
            '.',
        );
        value = value.substring(0, MAX_VALUE_SIZE);
      }

      if (shouldTrimParam(metadata, MAX_OBJ_SIZE)) {
        this.outputLogger.warn(
          'statsigSDK::logEvent> metadata is too big. Dropping the metadata.',
        );
        metadata = { statsig_error: 'Metadata length too large' };
      }

      let event = new LogEvent(eventName);
      event.setUser(user);
      event.setValue(value);
      event.setMetadata(metadata);

      if (typeof time === 'number') {
        event.setTime(time);
      }

      this._logger.log(event);
    });
  }

  /**
   * Informs the statsig SDK that the server is closing or shutting down
   * so the SDK can clean up internal state
   */
  public shutdown() {
    if (this._logger == null) {
      return;
    }

    this._errorBoundary.swallow(() => {
      this._ready = false;
      this._logger.shutdown();
      this._fetcher.shutdown();
      this._evaluator.shutdown();
    });
  }

  public async flush(): Promise<void> {
    return this._errorBoundary.capture(
      () => {
        if (this._logger == null) {
          return Promise.resolve();
        }

        return this._logger.flush();
      },
      () => Promise.resolve(),
    );
  }

  public clearAllGateOverrides(): void {
    this._evaluator.clearAllGateOverrides();
  }

  public clearAllConfigOverrides(): void {
    this._evaluator.clearAllConfigOverrides();
  }

  public clearAllLayerOverrides(): void {
    this._evaluator.clearAllLayerOverrides();
  }

  public async syncStoreSpecs(): Promise<void> {
    await this._evaluator.syncStoreSpecs();
  }

  public async syncStoreIdLists(): Promise<void> {
    await this._evaluator.syncStoreIdLists();
  }

  public getClientInitializeResponse(
    user: StatsigUser,
    options?: ClientInitializeResponseOptions,
  ): ClientInitializeResponse | null {
    return this._errorBoundary.capture(
      () => {
        if (this._ready !== true) {
          throw new StatsigUninitializedError();
        }
        let normalizedUser = user;
        if (user.statsigEnvironment == null) {
          normalizedUser = normalizeUser(user, this._options);
        }
        return this._evaluator.getClientInitializeResponse(
          normalizedUser,
          options,
        );
      },
      () => null,
    );
  }

  public overrideGate(
    gateName: string,
    value: boolean,
    userID: string | null = '',
  ) {
    this._errorBoundary.swallow(() => {
      if (typeof value !== 'boolean') {
        this.outputLogger.warn(
          'statsigSDK> Attempted to override a gate with a non boolean value',
        );
        return;
      }
      this._evaluator.overrideGate(gateName, value, userID);
    });
  }

  public overrideConfig(
    configName: string,
    value: Record<string, unknown>,
    userID: string | null = '',
  ) {
    this._errorBoundary.swallow(() => {
      if (typeof value !== 'object') {
        this.outputLogger.warn(
          'statsigSDK> Attempted to override a config with a non object value',
        );
        return;
      }
      this._evaluator.overrideConfig(configName, value, userID);
    });
  }

  public overrideLayer(
    layerName: string,
    value: Record<string, unknown>,
    userID: string | null = '',
  ) {
    this._errorBoundary.swallow(() => {
      if (typeof value !== 'object') {
        this.outputLogger.warn(
          'statsigSDK> Attempted to override a layer with a non object value',
        );
        return;
      }
      this._evaluator.overrideLayer(layerName, value, userID);
    });
  }

  public getFeatureGateList(): string[] {
    return this._evaluator.getFeatureGateList();
  }

  public getDynamicConfigList(): string[] {
    return this._evaluator.getConfigsList('dynamic_config');
  }

  public getExperimentList(): string[] {
    return this._evaluator.getConfigsList('experiment');
  }

  public getAutotuneList(): string[] {
    return this._evaluator.getConfigsList('autotune');
  }

  public getLayerList(): string[] {
    return this._evaluator.getLayerList();
  }

  //#region Deprecated Async Methods

  /**
   * @deprecated Please use checkGateSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public checkGate(user: StatsigUser, gateName: string): Promise<boolean> {
    return asyncify(() => this.getFeatureGateSync(user, gateName).value);
  }

  /**
   * @deprecated Please use getFeatureGateSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getFeatureGate(
    user: StatsigUser,
    gateName: string,
  ): Promise<FeatureGate> {
    return asyncify(() => this.getFeatureGateSync(user, gateName));
  }

  /**
   * @deprecated Please use checkGateWithExposureLoggingDisabledSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public async checkGateWithExposureLoggingDisabled(
    user: StatsigUser,
    gateName: string,
  ): Promise<boolean> {
    return asyncify(
      () =>
        this.getFeatureGateWithExposureLoggingDisabledSync(user, gateName)
          .value,
    );
  }

  /**
   * @deprecated Please use getFeatureGateWithExposureLoggingDisabledSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getFeatureGateWithExposureLoggingDisabled(
    user: StatsigUser,
    gateName: string,
  ): Promise<FeatureGate> {
    return asyncify(() =>
      this.getFeatureGateWithExposureLoggingDisabledSync(user, gateName),
    );
  }

  /**
   * @deprecated Please use getConfigSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getConfig(
    user: StatsigUser,
    configName: string,
  ): Promise<DynamicConfig> {
    return asyncify(() => this.getConfigSync(user, configName));
  }

  /**
   * @deprecated Please use getConfigWithExposureLoggingDisabledSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getConfigWithExposureLoggingDisabled(
    user: StatsigUser,
    configName: string,
  ): Promise<DynamicConfig> {
    return asyncify(() =>
      this.getConfigWithExposureLoggingDisabledSync(user, configName),
    );
  }

  /**
   * @deprecated Please use getExperimentSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getExperiment(
    user: StatsigUser,
    experimentName: string,
  ): Promise<DynamicConfig> {
    return this.getConfig(user, experimentName);
  }

  /**
   * @deprecated Please use getExperimentWithExposureLoggingDisabledSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getExperimentWithExposureLoggingDisabled(
    user: StatsigUser,
    experimentName: string,
  ): Promise<DynamicConfig> {
    return this.getConfigWithExposureLoggingDisabled(user, experimentName);
  }

  /**
   * @deprecated Please use getLayerSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getLayer(user: StatsigUser, layerName: string): Promise<Layer> {
    return asyncify(() => this.getLayerSync(user, layerName));
  }

  /**
   * @deprecated Please use getLayerWithExposureLoggingDisabledSync instead.
   * @see https://docs.statsig.com/server/deprecation-notices
   */
  public getLayerWithExposureLoggingDisabled(
    user: StatsigUser,
    layerName: string,
  ): Promise<Layer> {
    return asyncify(() =>
      this.getLayerWithExposureLoggingDisabledSync(user, layerName),
    );
  }

  //#endregion

  //
  // PRIVATE
  //

  private logGateExposureImpl(
    user: StatsigUser,
    gateName: string,
    evaluation: ConfigEvaluation,
    exposureCause: ExposureCause,
  ) {
    this._logger.logGateExposure(
      user,
      gateName,
      evaluation,
      exposureCause === ExposureCause.Manual,
    );
  }

  private getGateImpl(
    inputUser: StatsigUser,
    gateName: string,
    exposureLogging: ExposureLogging,
  ): FeatureGate {
    const { error, normalizedUser: user } = this._validateInputs(
      inputUser,
      gateName,
    );

    if (error) {
      throw error;
    }

    const evaluation = this._evaluator.checkGate(user, gateName);
    if (exposureLogging !== ExposureLogging.Disabled) {
      this.logGateExposureImpl(
        user,
        gateName,
        evaluation,
        ExposureCause.Automatic,
      );
    } else {
      this._logger.incrementNonExposedChecks(gateName);
    }

    return makeFeatureGate(
      gateName,
      evaluation.rule_id,
      evaluation.value === true,
      evaluation.group_name,
      evaluation.secondary_exposures,
    );
  }

  private logConfigExposureImpl(
    user: StatsigUser,
    configName: string,
    evaluation: ConfigEvaluation,
    exposureCause: ExposureCause,
  ) {
    this._logger.logConfigExposure(
      user,
      configName,
      evaluation,
      exposureCause === ExposureCause.Manual,
    );
  }

  private getConfigImpl(
    inputUser: StatsigUser,
    configName: string,
    exposureLogging: ExposureLogging,
  ): DynamicConfig {
    const { error, normalizedUser: user } = this._validateInputs(
      inputUser,
      configName,
    );

    if (error) {
      throw error;
    }

    const evaluation = this._evaluator.getConfig(user, configName);
    const config = new DynamicConfig(
      configName,
      evaluation.json_value as Record<string, unknown>,
      evaluation.rule_id,
      evaluation.group_name,
      evaluation.secondary_exposures,
      evaluation.rule_id !== ''
        ? this._makeOnDefaultValueFallbackFunction(user)
        : null,
    );

    if (exposureLogging !== ExposureLogging.Disabled) {
      this.logConfigExposureImpl(
        user,
        configName,
        evaluation,
        ExposureCause.Automatic,
      );
    } else {
      this._logger.incrementNonExposedChecks(configName);
    }

    return config;
  }

  private getLayerImpl(
    inputUser: StatsigUser,
    layerName: string,
    exposureLogging: ExposureLogging,
  ): Layer {
    const { error, normalizedUser: user } = this._validateInputs(
      inputUser,
      layerName,
    );

    if (error) {
      throw error;
    }

    const ret = this._evaluator.getLayer(user, layerName);
    const logFunc = (layer: Layer, parameterName: string) => {
      this.logLayerParameterExposureImpl(
        user,
        layerName,
        parameterName,
        ret,
        ExposureCause.Automatic,
      );
    };

    if (exposureLogging === ExposureLogging.Disabled) {
      this._logger.incrementNonExposedChecks(layerName);
    }

    return new Layer(
      layerName,
      ret?.json_value as Record<string, unknown>,
      ret?.rule_id,
      exposureLogging === ExposureLogging.Disabled ? null : logFunc,
    );
  }

  private logLayerParameterExposureImpl(
    user: StatsigUser,
    layerName: string,
    parameterName: string,
    evaluation: ConfigEvaluation,
    exposureCause: ExposureCause,
  ) {
    if (this._logger == null) {
      return;
    }

    this._logger.logLayerExposure(
      user,
      layerName,
      parameterName,
      evaluation,
      exposureCause === ExposureCause.Manual,
    );
  }

  private _validateInputs(user: StatsigUser, configName: string) {
    const result: {
      error: null | Error;
      normalizedUser: StatsigUser;
    } = { error: null, normalizedUser: { userID: '' } };
    if (this._ready !== true) {
      result.error = new StatsigUninitializedError();
    } else if (typeof configName !== 'string' || configName.length === 0) {
      result.error = new StatsigInvalidArgumentError(
        'Lookup key must be a non-empty string',
      );
    } else if (!isUserIdentifiable(user)) {
      result.error = new StatsigInvalidArgumentError(
        'Must pass a valid user with a userID or customID for the server SDK to work. See https://docs.statsig.com/messages/serverRequiredUserID/ for more details.',
      );
    } else {
      result.normalizedUser = normalizeUser(user, this._options);
    }

    const resetError = this._evaluator.resetSyncTimerIfExited();
    if (resetError != null) {
      this._errorBoundary.logError(resetError, 'reset_sync_time');
    }

    return result;
  }

  private _makeOnDefaultValueFallbackFunction(
    user: StatsigUser,
  ): OnDefaultValueFallback | null {
    if (!this._ready) {
      return null;
    }

    return (config, parameter, defaultValueType, valueType) => {
      this._logger.logConfigDefaultValueFallback(
        user,
        `Parameter ${parameter} is a value of type ${valueType}.
      Returning requested defaultValue type ${defaultValueType}`,
        {
          name: config.name,
          ruleID: config.getRuleID(),
          parameter,
          defaultValueType,
          valueType,
        },
      );
    };
  }
}

function shouldTrimParam(
  param: object | string | number | null | unknown,
  size: number,
): boolean {
  if (param == null) return false;
  if (typeof param === 'string') return param.length > size;
  if (typeof param === 'object') {
    return approximateObjectSize(param) > size;
  }
  if (typeof param === 'number') return param.toString().length > size;
  return false;
}

function approximateObjectSize(x: object): number {
  let size = 0;
  const entries = Object.entries(x);
  for (let i = 0; i < entries.length; i++) {
    const key = entries[i][0];
    const value = entries[i][1] as unknown;
    if (typeof value === 'object' && value !== null) {
      size += approximateObjectSize(value);
    } else {
      size += String(value).length;
    }
    size += key.length;
  }
  return size;
}

function normalizeUser(
  user: StatsigUser,
  options: ExplicitStatsigOptions,
): StatsigUser {
  user = trimUserObjIfNeeded(user);
  user = JSON.parse(JSON.stringify(user));
  if (options?.environment != null) {
    user['statsigEnvironment'] = options?.environment;
  }
  return user;
}

function trimUserObjIfNeeded(user: StatsigUser): StatsigUser {
  if (user == null) return { customIDs: {} }; // Being defensive here

  if (user.userID != null && shouldTrimParam(user.userID, MAX_VALUE_SIZE)) {
    OutputLogger.getLogger().warn(
      'statsigSDK> User ID is too large, trimming to ' + MAX_VALUE_SIZE,
    );
    user.userID = user.userID.toString().substring(0, MAX_VALUE_SIZE);
  }

  if (shouldTrimParam(user, MAX_USER_SIZE)) {
    user.custom = { statsig_error: 'User object length too large' };
    if (shouldTrimParam(user, MAX_USER_SIZE)) {
      OutputLogger.getLogger().warn(
        'statsigSDK> User object is too large, only keeping the user ID.',
      );
      user = { userID: user.userID, customIDs: user.customIDs ?? {} };
    } else {
      OutputLogger.getLogger().warn(
        'statsigSDK> User object is too large, dropping the custom property.',
      );
    }
  }
  return user;
}
