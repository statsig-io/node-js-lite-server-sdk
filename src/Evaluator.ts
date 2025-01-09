import { ConfigCondition, ConfigRule, ConfigSpec } from './ConfigSpec';
import {
  HashingAlgorithm,
  hashString,
  hashUnitIDForIDList,
  sha256Hash,
} from './utils/Hashing';
import { getSDKType, getSDKVersion, notEmpty } from './utils/core';

import { ClientInitializeResponseOptions } from './StatsigServer';
import ConfigEvaluation from './ConfigEvaluation';
import Diagnostics from './Diagnostics';
import { EvaluationDetails } from './EvaluationDetails';
import { ExplicitStatsigOptions } from './StatsigOptions';
import { SecondaryExposure } from './LogEvent';
import SpecStore from './SpecStore';
import StatsigFetcher from './utils/StatsigFetcher';
import { StatsigUser } from './StatsigUser';
import parseUserAgent from './utils/parseUserAgent';

const CONDITION_SEGMENT_COUNT = 10 * 1000;
const USER_BUCKET_COUNT = 1000;

type InitializeResponse = {
  name: string;
  value: unknown;
  group: string;
  rule_id: string;
  is_device_based: boolean;
  secondary_exposures: unknown;
  is_experiment_active?: boolean;
  is_user_in_experiment?: boolean;
  is_in_layer?: boolean;
  allocated_experiment_name?: string;
  explicit_parameters?: string[];
  undelegated_secondary_exposures?: Record<string, string>[];
  group_name?: string | null;
  id_type?: string | null;
};

export type ClientInitializeResponse = {
  feature_gates: Record<string, InitializeResponse>;
  dynamic_configs: Record<string, InitializeResponse>;
  layer_configs: Record<string, InitializeResponse>;
  sdkParams: Record<string, unknown>;
  has_updates: boolean;
  generator: 'statsig-node-lite-sdk';
  sdkInfo: { sdkType: string; sdkVersion: string };
  time: number;
  evaluated_keys: Record<string, unknown>;
  hash_used: HashingAlgorithm;
  user: StatsigUser;
};

export default class Evaluator {
  private gateOverrides: Record<string, Record<string, boolean>>;
  private configOverrides: Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  private layerOverrides: Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  private initialized: boolean = false;

  private store: SpecStore;

  public constructor(
    fetcher: StatsigFetcher,
    options: ExplicitStatsigOptions,
    diagnostics: Diagnostics,
  ) {
    this.store = new SpecStore(fetcher, options, diagnostics);
    this.gateOverrides = {};
    this.configOverrides = {};
    this.layerOverrides = {};
  }

  public async init(): Promise<void> {
    await this.store.init();
    this.initialized = true;
  }

  public overrideGate(
    gateName: string,
    value: boolean,
    userID: string | null = null,
  ): void {
    const overrides = this.gateOverrides[gateName] ?? {};
    overrides[userID == null ? '' : userID] = value;
    this.gateOverrides[gateName] = overrides;
  }

  public overrideConfig(
    configName: string,
    value: Record<string, unknown>,
    userID: string | null = '',
  ): void {
    const overrides = this.configOverrides[configName] ?? {};
    overrides[userID == null ? '' : userID] = value;
    this.configOverrides[configName] = overrides;
  }

  public overrideLayer(
    layerName: string,
    value: Record<string, unknown>,
    userID: string | null = '',
  ): void {
    const overrides = this.layerOverrides[layerName] ?? {};
    overrides[userID == null ? '' : userID] = value;
    this.layerOverrides[layerName] = overrides;
  }

  public checkGate(user: StatsigUser, gateName: string): ConfigEvaluation {
    const override = this.lookupGateOverride(user, gateName);
    if (override) {
      return override.withEvaluationDetails(
        EvaluationDetails.make(
          this.store.getLastUpdateTime(),
          this.store.getInitialUpdateTime(),
          'LocalOverride',
        ),
      );
    }

    if (this.store.getInitReason() === 'Uninitialized') {
      return new ConfigEvaluation(false).withEvaluationDetails(
        EvaluationDetails.uninitialized(),
      );
    }

    return this._evalSpec(user, this.store.getGate(gateName));
  }

  public getConfig(user: StatsigUser, configName: string): ConfigEvaluation {
    const override = this.lookupConfigOverride(user, configName);
    if (override) {
      return override.withEvaluationDetails(
        EvaluationDetails.make(
          this.store.getLastUpdateTime(),
          this.store.getInitialUpdateTime(),
          'LocalOverride',
        ),
      );
    }

    if (this.store.getInitReason() === 'Uninitialized') {
      return new ConfigEvaluation(false).withEvaluationDetails(
        EvaluationDetails.uninitialized(),
      );
    }

    return this._evalSpec(user, this.store.getConfig(configName));
  }

  public getLayer(user: StatsigUser, layerName: string): ConfigEvaluation {
    const override = this.lookupLayerOverride(user, layerName);
    if (override) {
      return override.withEvaluationDetails(
        EvaluationDetails.make(
          this.store.getLastUpdateTime(),
          this.store.getInitialUpdateTime(),
          'LocalOverride',
        ),
      );
    }

    if (this.store.getInitReason() === 'Uninitialized') {
      return new ConfigEvaluation(false).withEvaluationDetails(
        EvaluationDetails.uninitialized(),
      );
    }

    return this._evalSpec(user, this.store.getLayer(layerName));
  }

  public getClientInitializeResponse(
    user: StatsigUser,
    options?: ClientInitializeResponseOptions,
  ): ClientInitializeResponse | null {
    if (!this.store.isServingChecks()) {
      return null;
    }
    const gates = Object.entries(this.store.getAllGates())
      .map(([gate, spec]) => {
        if (spec?.entity === 'segment' || spec?.entity === 'holdout') {
          return null;
        }
        const res = this._eval(user, spec);
        return {
          name: hashString(gate, options?.hash),
          value: res.unsupported ? false : res.value,
          rule_id: res.rule_id,
          secondary_exposures: this._cleanExposures(res.secondary_exposures),
          id_type: spec.idType,
        };
      })
      .filter((item) => item !== null);

    const configs = Object.entries(this.store.getAllConfigs()).map(
      ([config, spec]) => {
        const res = this._eval(user, spec);
        const format = this._specToInitializeResponse(spec, res, options?.hash);
        if (spec.idType != null) {
          format.id_type = spec.idType;
        }
        if (spec.entity !== 'dynamic_config' && spec.entity !== 'autotune') {
          format.is_user_in_experiment = this._isUserAllocatedToExperiment(
            user,
            spec,
          );
          format.is_experiment_active = this._isExperimentActive(spec);
          if (spec.hasSharedParams) {
            format.is_in_layer = true;
            format.explicit_parameters = spec.explicitParameters ?? [];

            let layerValue = {};
            const layerName = this.store.getExperimentLayer(spec.name);
            if (layerName != null) {
              const layer = this.store.getLayer(layerName);
              if (layer != null) {
                layerValue = layer.defaultValue as object;
              }
            }

            format.value = {
              ...layerValue,
              ...(format.value as object),
            };
          }
        }

        return format;
      },
    );

    const layers = Object.entries(this.store.getAllLayers()).map(
      ([layer, spec]) => {
        const res = this._eval(user, spec);
        const format = this._specToInitializeResponse(spec, res, options?.hash);
        format.explicit_parameters = spec.explicitParameters ?? [];
        if (res.config_delegate != null && res.config_delegate !== '') {
          const delegateSpec = this.store.getConfig(res.config_delegate);
          format.allocated_experiment_name = hashString(
            res.config_delegate,
            options?.hash,
          );

          format.is_experiment_active = this._isExperimentActive(delegateSpec);
          format.is_user_in_experiment = this._isUserAllocatedToExperiment(
            user,
            delegateSpec,
          );
          format.explicit_parameters = delegateSpec?.explicitParameters ?? [];
        }

        format.undelegated_secondary_exposures = this._cleanExposures(
          res.undelegated_secondary_exposures ?? [],
        );

        return format;
      },
    );

    const evaluatedKeys: Record<string, unknown> = {};
    if (user.userID) {
      evaluatedKeys['userID'] = user.userID;
    }
    if (user.customIDs && Object.keys(user.customIDs).length > 0) {
      evaluatedKeys['customIDs'] = user.customIDs;
    }

    delete user.privateAttributes;

    return {
      feature_gates: Object.assign(
        {},
        ...gates.map((item) => ({ [item!!.name]: item })),
      ),
      dynamic_configs: Object.assign(
        {},
        ...configs.map((item) => ({ [item.name]: item })),
      ),
      layer_configs: Object.assign(
        {},
        ...layers.map((item) => ({ [item.name]: item })),
      ),
      sdkParams: {},
      has_updates: true,
      generator: 'statsig-node-lite-sdk',
      sdkInfo: { sdkType: getSDKType(), sdkVersion: getSDKVersion() },
      time: this.store.getLastUpdateTime(),
      evaluated_keys: evaluatedKeys,
      hash_used: options?.hash ?? 'sha256',
      user: user,
    };
  }

  public resetSyncTimerIfExited(): Error | null {
    return this.store.resetSyncTimerIfExited();
  }

  public syncBootstrapValues(bootstrapValues: string): void {
    this.store.syncBootstrapValues(bootstrapValues);
  }

  public async syncStoreSpecs(): Promise<void> {
    await this.store.syncValues();
  }

  public async syncStoreIdLists(): Promise<void> {
    await this.store.syncIdLists();
  }

  public getFeatureGateList(): string[] {
    const gates = this.store.getAllGates();
    return Object.entries(gates).map(([name, _]) => name);
  }

  public getConfigsList(
    entityType: 'experiment' | 'dynamic_config' | 'autotune',
  ): string[] {
    const configs = this.store.getAllConfigs();
    return Object.entries(configs)
      .filter(([_, config]) => config.entity === entityType)
      .map(([name, _]) => name);
  }

  public getLayerList(): string[] {
    const layers = this.store.getAllLayers();
    return Object.entries(layers).map(([name, _]) => name);
  }

  private lookupGateOverride(
    user: StatsigUser,
    gateName: string,
  ): ConfigEvaluation | null {
    const overrides = this.gateOverrides[gateName];
    if (overrides == null) {
      return null;
    }
    if (user.userID != null) {
      // check for a user level override
      const userOverride = overrides[user.userID];
      if (userOverride != null) {
        return new ConfigEvaluation(userOverride, 'override');
      }
    }

    // check if there is a global override
    const allOverride = overrides[''];
    if (allOverride != null) {
      return new ConfigEvaluation(allOverride, 'override');
    }
    return null;
  }

  private lookupConfigOverride(
    user: StatsigUser,
    configName: string,
  ): ConfigEvaluation | null {
    const overrides = this.configOverrides[configName];
    return this.lookupConfigBasedOverride(user, overrides);
  }

  private lookupLayerOverride(
    user: StatsigUser,
    layerName: string,
  ): ConfigEvaluation | null {
    const overrides = this.layerOverrides[layerName];
    return this.lookupConfigBasedOverride(user, overrides);
  }

  private lookupConfigBasedOverride(
    user: StatsigUser,
    overrides: Record<string, Record<string, unknown>>,
  ): ConfigEvaluation | null {
    if (overrides == null) {
      return null;
    }

    if (user.userID != null) {
      // check for a user level override
      const userOverride = overrides[user.userID];
      if (userOverride != null) {
        return new ConfigEvaluation(true, 'override', null, [], userOverride);
      }
    }

    // check if there is a global override
    const allOverride = overrides[''];
    if (allOverride != null) {
      return new ConfigEvaluation(true, 'override', null, [], allOverride);
    }
    return null;
  }

  private _specToInitializeResponse(
    spec: ConfigSpec,
    res: ConfigEvaluation,
    hash?: HashingAlgorithm,
  ): InitializeResponse {
    const output: InitializeResponse = {
      name: hashString(spec.name, hash),
      value: res.unsupported ? {} : res.json_value,
      group: res.rule_id,
      rule_id: res.rule_id,
      is_device_based:
        spec.idType != null && spec.idType.toLowerCase() === 'stableid',
      secondary_exposures: this._cleanExposures(res.secondary_exposures),
    };
    if (res.group_name != null && res.group_name !== '') {
      output.group_name = res.group_name;
    }

    if (res.explicit_parameters) {
      output.explicit_parameters = res.explicit_parameters;
    }

    return output;
  }

  private _cleanExposures(exposures: SecondaryExposure[]): SecondaryExposure[] {
    const seen: Record<string, boolean> = {};
    return exposures
      .filter((exposure) => !exposure.gate.startsWith('segment:'))
      .map((exposure) => {
        const key = `${exposure.gate}|${exposure.gateValue}|${exposure.ruleID}`;
        if (seen[key]) {
          return null;
        }
        seen[key] = true;
        return exposure;
      })
      .filter(notEmpty);
  }

  public shutdown() {
    this.store.shutdown();
  }

  _evalSpec(user: StatsigUser, config: ConfigSpec | null): ConfigEvaluation {
    if (!config) {
      return new ConfigEvaluation(false, '', null).withEvaluationDetails(
        EvaluationDetails.make(
          this.store.getLastUpdateTime(),
          this.store.getInitialUpdateTime(),
          'Unrecognized',
        ),
      );
    }

    const evaulation = this._eval(user, config);
    evaulation.secondary_exposures = this._cleanExposures(
      evaulation.secondary_exposures,
    );
    if (evaulation.evaluation_details) {
      return evaulation;
    }

    return evaulation.withEvaluationDetails(
      EvaluationDetails.make(
        this.store.getLastUpdateTime(),
        this.store.getInitialUpdateTime(),
        this.store.getInitReason(),
      ),
    );
  }

  _eval(user: StatsigUser, config: ConfigSpec): ConfigEvaluation {
    if (!config.enabled) {
      return new ConfigEvaluation(
        false,
        'disabled',
        null,
        [],
        config.defaultValue as Record<string, unknown>,
        null, // explicit_parameters
        null, // config_delegate
        config.version,
      );
    }

    let secondary_exposures: SecondaryExposure[] = [];
    for (let i = 0; i < config.rules.length; i++) {
      const rule = config.rules[i];
      const ruleResult = this._evalRule(user, rule);
      if (ruleResult.unsupported) {
        return ConfigEvaluation.unsupported(
          this.store.getLastUpdateTime(),
          this.store.getInitialUpdateTime(),
          config.version,
        );
      }

      secondary_exposures = secondary_exposures.concat(
        ruleResult.secondary_exposures,
      );

      if (ruleResult.value === true) {
        const delegatedResult = this._evalDelegate(
          user,
          rule,
          secondary_exposures,
        );
        if (delegatedResult) {
          return delegatedResult;
        }

        const pass = this._evalPassPercent(user, rule, config);
        const evaluation = new ConfigEvaluation(
          pass,
          ruleResult.rule_id,
          ruleResult.group_name,
          secondary_exposures,
          pass
            ? ruleResult.json_value
            : (config.defaultValue as Record<string, unknown>),
          config.explicitParameters,
          ruleResult.config_delegate,
          config.version,
        );
        evaluation.setIsExperimentGroup(ruleResult.is_experiment_group);
        return evaluation;
      }
    }

    return new ConfigEvaluation(
      false,
      'default',
      null,
      secondary_exposures,
      config.defaultValue as Record<string, unknown>,
      config.explicitParameters,
      null, // config_delegate
      config.version,
    );
  }

  _evalDelegate(
    user: StatsigUser,
    rule: ConfigRule,
    exposures: SecondaryExposure[],
  ) {
    if (rule.configDelegate == null) {
      return null;
    }
    const config = this.store.getConfig(rule.configDelegate);
    if (!config) {
      return null;
    }

    const delegatedResult = this._eval(user, config);
    delegatedResult.config_delegate = rule.configDelegate;
    delegatedResult.undelegated_secondary_exposures = exposures;
    delegatedResult.explicit_parameters = config.explicitParameters;
    delegatedResult.secondary_exposures = exposures.concat(
      delegatedResult.secondary_exposures,
    );
    delegatedResult.group_name =
      delegatedResult.group_name ?? rule.groupName ?? null;
    return delegatedResult;
  }

  _evalPassPercent(user: StatsigUser, rule: ConfigRule, config: ConfigSpec) {
    const hash = computeUserHash(
      config.salt +
        '.' +
        (rule.salt ?? rule.id) +
        '.' +
        (this._getUnitID(user, rule.idType) ?? ''),
    );
    return (
      Number(hash % BigInt(CONDITION_SEGMENT_COUNT)) < rule.passPercentage * 100
    );
  }

  _getUnitID(user: StatsigUser, idType: string) {
    if (typeof idType === 'string' && idType.toLowerCase() !== 'userid') {
      const unitID = user?.customIDs?.[idType];
      if (unitID !== undefined) {
        return unitID;
      }
      return getParameterCaseInsensitive(user?.customIDs, idType);
    }
    return user?.userID;
  }

  _evalRule(user: StatsigUser, rule: ConfigRule) {
    let secondaryExposures: SecondaryExposure[] = [];
    let pass = true;

    for (const condition of rule.conditions) {
      const result = this._evalCondition(user, condition);
      if (result.unsupported) {
        return ConfigEvaluation.unsupported(
          this.store.getLastUpdateTime(),
          this.store.getInitialUpdateTime(),
          undefined,
        );
      }

      if (!result.passes) {
        pass = false;
      }

      if (result.exposures) {
        secondaryExposures = secondaryExposures.concat(result.exposures);
      }
    }

    const evaluation = new ConfigEvaluation(
      pass,
      rule.id,
      rule.groupName,
      secondaryExposures,
      rule.returnValue as Record<string, unknown>,
    );
    evaluation.setIsExperimentGroup(rule.isExperimentGroup ?? false);
    return evaluation;
  }

  _evalCondition(
    user: StatsigUser,
    condition: ConfigCondition,
  ): {
    passes: boolean;
    unsupported?: boolean;
    exposures?: SecondaryExposure[];
  } {
    let value = null;
    const field = condition.field;
    const target = condition.targetValue;
    const idType = condition.idType;
    switch (condition.type.toLowerCase()) {
      case 'public':
        return { passes: true };
      case 'fail_gate':
      case 'pass_gate': {
        const gateResult = this.checkGate(user, target as string);
        if (gateResult?.unsupported) {
          return { passes: false, unsupported: true };
        }
        value = gateResult?.value;

        const allExposures = gateResult?.secondary_exposures ?? [];
        allExposures.push({
          gate: String(target),
          gateValue: String(value),
          ruleID: gateResult?.rule_id ?? '',
        });

        return {
          passes:
            condition.type.toLowerCase() === 'fail_gate' ? !value : !!value,
          exposures: allExposures,
        };
      }
      case 'multi_pass_gate':
      case 'multi_fail_gate': {
        if (!Array.isArray(target)) {
          return { passes: false, unsupported: true };
        }
        const gateNames = target as string[];
        let value = false;
        let exposures: SecondaryExposure[] = [];
        for (const gateName of gateNames) {
          const gateResult = this.checkGate(user, gateName as string);
          if (gateResult?.unsupported) {
            return { passes: false, unsupported: true };
          }
          const resValue =
            condition.type === 'multi_pass_gate'
              ? gateResult.value === true
              : gateResult.value === false;
          exposures.push({
            gate: String(gateName),
            gateValue: String(gateResult?.value),
            ruleID: gateResult?.rule_id ?? '',
          });
          exposures = exposures.concat(gateResult.secondary_exposures);

          if (resValue === true) {
            value = true;
            break;
          }
        }
        return {
          passes: value,
          exposures: exposures,
        };
      }
      case 'ip_based':
        // this would apply to things like 'country', 'region', etc.
        value = getFromUser(user, field);
        break;
      case 'ua_based':
        // this would apply to things like 'os', 'browser', etc.
        value = getFromUser(user, field) ?? getFromUserAgent(user, field);
        break;
      case 'user_field':
        value = getFromUser(user, field);
        break;
      case 'environment_field':
        value = getFromEnvironment(user, field);
        break;
      case 'current_time':
        value = Date.now();
        break;
      case 'user_bucket': {
        const salt = condition.additionalValues?.salt;
        const userHash = computeUserHash(
          salt + '.' + (this._getUnitID(user, idType) ?? ''),
        );
        value = Number(userHash % BigInt(USER_BUCKET_COUNT));
        break;
      }
      case 'unit_id':
        value = this._getUnitID(user, idType);
        break;
      default:
        return { passes: false, unsupported: true };
    }

    const op = condition.operator?.toLowerCase();
    let evalResult = false;
    switch (op) {
      // numerical
      case 'gt':
        evalResult = numberCompare((a: number, b: number) => a > b)(
          value,
          target,
        );
        break;
      case 'gte':
        evalResult = numberCompare((a: number, b: number) => a >= b)(
          value,
          target,
        );
        break;
      case 'lt':
        evalResult = numberCompare((a: number, b: number) => a < b)(
          value,
          target,
        );
        break;
      case 'lte':
        evalResult = numberCompare((a: number, b: number) => a <= b)(
          value,
          target,
        );
        break;

      // version
      case 'version_gt':
        evalResult = versionCompareHelper((result) => result > 0)(
          value,
          target as string,
        );
        break;
      case 'version_gte':
        evalResult = versionCompareHelper((result) => result >= 0)(
          value,
          target as string,
        );
        break;
      case 'version_lt':
        evalResult = versionCompareHelper((result) => result < 0)(
          value,
          target as string,
        );
        break;
      case 'version_lte':
        evalResult = versionCompareHelper((result) => result <= 0)(
          value,
          target as string,
        );
        break;
      case 'version_eq':
        evalResult = versionCompareHelper((result) => result === 0)(
          value,
          target as string,
        );
        break;
      case 'version_neq':
        evalResult = versionCompareHelper((result) => result !== 0)(
          value,
          target as string,
        );
        break;

      // array
      case 'any':
        evalResult = arrayAny(
          value,
          target,
          stringCompare(true, (a, b) => a === b),
        );
        break;
      case 'none':
        evalResult = !arrayAny(
          value,
          target,
          stringCompare(true, (a, b) => a === b),
        );
        break;
      case 'any_case_sensitive':
        evalResult = arrayAny(
          value,
          target,
          stringCompare(false, (a, b) => a === b),
        );
        break;
      case 'none_case_sensitive':
        evalResult = !arrayAny(
          value,
          target,
          stringCompare(false, (a, b) => a === b),
        );
        break;

      // string
      case 'str_starts_with_any':
        evalResult = arrayAny(
          value,
          target,
          stringCompare(true, (a, b) => a.startsWith(b)),
        );
        break;
      case 'str_ends_with_any':
        evalResult = arrayAny(
          value,
          target,
          stringCompare(true, (a, b) => a.endsWith(b)),
        );
        break;
      case 'str_contains_any':
        evalResult = arrayAny(
          value,
          target,
          stringCompare(true, (a, b) => a.includes(b)),
        );
        break;
      case 'str_contains_none':
        evalResult = !arrayAny(
          value,
          target,
          stringCompare(true, (a, b) => a.includes(b)),
        );
        break;
      case 'str_matches':
        try {
          if (String(value).length < 1000) {
            evalResult = new RegExp(target as string).test(String(value));
          } else {
            evalResult = false;
          }
        } catch (e) {
          evalResult = false;
        }
        break;
      // strictly equals
      case 'eq':
        evalResult = value == target;
        break;
      case 'neq':
        evalResult = value != target;
        break;

      // dates
      case 'before':
        evalResult = dateCompare((a, b) => a < b)(value, target as string);
        break;
      case 'after':
        evalResult = dateCompare((a, b) => a > b)(value, target as string);
        break;
      case 'on':
        evalResult = dateCompare((a, b) => {
          a?.setHours(0, 0, 0, 0);
          b?.setHours(0, 0, 0, 0);
          return a?.getTime() === b?.getTime();
        })(value, target as string);
        break;
      case 'in_segment_list':
      case 'not_in_segment_list': {
        const list = this.store.getIDList(target as string)?.ids;
        value = hashUnitIDForIDList(value);
        const inList = typeof list === 'object' && list[value] === true;
        evalResult = op === 'in_segment_list' ? inList : !inList;
        break;
      }
      case 'array_contains_any': {
        if (!Array.isArray(target)) {
          evalResult = false;
          break;
        }
        if (!Array.isArray(value)) {
          evalResult = false;
          break;
        }
        evalResult = arrayHasValue(value as unknown[], target as string[]);
        break;
      }
      case 'array_contains_none': {
        if (!Array.isArray(target)) {
          evalResult = false;
          break;
        }
        if (!Array.isArray(value)) {
          evalResult = false;
          break;
        }
        evalResult = !arrayHasValue(value as unknown[], target as string[]);
        break;
      }
      case 'array_contains_all': {
        if (!Array.isArray(target)) {
          evalResult = false;
          break;
        }
        if (!Array.isArray(value)) {
          evalResult = false;
          break;
        }
        evalResult = arrayHasAllValues(value as unknown[], target as string[]);
        break;
      }
      case 'not_array_contains_all': {
        if (!Array.isArray(target)) {
          evalResult = false;
          break;
        }
        if (!Array.isArray(value)) {
          evalResult = false;
          break;
        }
        evalResult = !arrayHasAllValues(value as unknown[], target as string[]);
        break;
      }
      default:
        return { passes: false, unsupported: true };
    }
    return { passes: evalResult };
  }

  _isExperimentActive(experimentConfig: ConfigSpec | null) {
    if (experimentConfig == null) {
      return false;
    }
    return experimentConfig.isActive === true;
  }

  _isUserAllocatedToExperiment(
    user: StatsigUser,
    experimentConfig: ConfigSpec | null,
  ) {
    if (experimentConfig == null) {
      return false;
    }
    const evalResult = this._eval(user, experimentConfig);
    return evalResult.is_experiment_group;
  }
}

const hashLookupTable: Map<string, bigint> = new Map();

export function computeUserHash(userHash: string) {
  const existingHash = hashLookupTable.get(userHash);
  if (existingHash) {
    return existingHash;
  }

  const hash = sha256Hash(userHash).getBigUint64(0, false);

  if (hashLookupTable.size > 100000) {
    hashLookupTable.clear();
  }

  hashLookupTable.set(userHash, hash);
  return hash;
}

function getFromUser(user: StatsigUser, field: string): any | null {
  if (typeof user !== 'object') {
    return null;
  }
  const indexableUser = user as { [field: string]: unknown };

  return (
    indexableUser[field] ??
    indexableUser[field.toLowerCase()] ??
    user?.custom?.[field] ??
    user?.custom?.[field.toLowerCase()] ??
    user?.privateAttributes?.[field] ??
    user?.privateAttributes?.[field.toLowerCase()]
  );
}

function getFromUserAgent(user: StatsigUser, field: string) {
  const ua = getFromUser(user, 'userAgent');
  if (ua == null) {
    return null;
  }

  if (typeof ua !== 'string' || ua.length > 1000) {
    return null;
  }
  const res = parseUserAgent(ua);
  switch (field.toLowerCase()) {
    case 'os_name':
    case 'osname':
      return res.os.name ?? null;
    case 'os_version':
    case 'osversion':
      return res.os.version ?? null;
    case 'browser_name':
    case 'browsername':
      return res.browser.name ?? null;
    case 'browser_version':
    case 'browserversion':
      return res.browser.version ?? null;
    default:
      return null;
  }
}

function getFromEnvironment(user: StatsigUser, field: string) {
  return getParameterCaseInsensitive(user?.statsigEnvironment, field);
}

function getParameterCaseInsensitive(
  object: Record<string, unknown> | undefined | null,
  key: string,
): unknown | undefined {
  if (object == null) {
    return undefined;
  }
  const asLowercase = key.toLowerCase();
  const keyMatch = Object.keys(object).find(
    (k) => k.toLowerCase() === asLowercase,
  );
  if (keyMatch === undefined) {
    return undefined;
  }
  return object[keyMatch];
}

function numberCompare(
  fn: (a: number, b: number) => boolean,
): (a: unknown, b: unknown) => boolean {
  return (a: unknown, b: unknown) => {
    if (a == null || b == null) {
      return false;
    }
    const numA = Number(a);
    const numB = Number(b);
    if (isNaN(numA) || isNaN(numB)) {
      return false;
    }
    return fn(numA, numB);
  };
}

function versionCompareHelper(
  fn: (res: number) => boolean,
): (a: string, b: string) => boolean {
  return (a: string, b: string) => {
    const comparison = versionCompare(a, b);
    if (comparison == null) {
      return false;
    }
    return fn(comparison);
  };
}

// Compare two version strings without the extensions.
// returns -1, 0, or 1 if first is smaller than, equal to, or larger than second.
// returns false if any of the version strings is not valid.
function versionCompare(first: string, second: string): number | null {
  if (typeof first !== 'string' || typeof second !== 'string') {
    return null;
  }
  const version1 = removeVersionExtension(first);
  const version2 = removeVersionExtension(second);
  if (version1.length === 0 || version2.length === 0) {
    return null;
  }

  const parts1 = version1.split('.');
  const parts2 = version2.split('.');
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    if (parts1[i] === undefined) {
      parts1[i] = '0';
    }
    if (parts2[i] === undefined) {
      parts2[i] = '0';
    }
    const n1 = Number(parts1[i]);
    const n2 = Number(parts2[i]);
    if (
      typeof n1 !== 'number' ||
      typeof n2 !== 'number' ||
      isNaN(n1) ||
      isNaN(n2)
    ) {
      return null;
    }
    if (n1 < n2) {
      return -1;
    } else if (n1 > n2) {
      return 1;
    }
  }
  return 0;
}

function removeVersionExtension(version: string): string {
  const hyphenIndex = version.indexOf('-');
  if (hyphenIndex >= 0) {
    return version.substr(0, hyphenIndex);
  }
  return version;
}

function stringCompare(
  ignoreCase: boolean,
  fn: (a: string, b: string) => boolean,
): (a: string, b: string) => boolean {
  return (a: string, b: string): boolean => {
    if (a == null || b == null) {
      return false;
    }
    return ignoreCase
      ? fn(String(a).toLowerCase(), String(b).toLowerCase())
      : fn(String(a), String(b));
  };
}

function dateCompare(
  fn: (a: Date, b: Date) => boolean,
): (a: string, b: string) => boolean {
  return (a: string, b: string): boolean => {
    if (a == null || b == null) {
      return false;
    }
    try {
      // Try to parse into date as a string first, if not, try unixtime
      let dateA = new Date(a);
      if (isNaN(dateA.getTime())) {
        dateA = new Date(Number(a));
      }

      let dateB = new Date(b);
      if (isNaN(dateB.getTime())) {
        dateB = new Date(Number(b));
      }
      return (
        !isNaN(dateA.getTime()) && !isNaN(dateB.getTime()) && fn(dateA, dateB)
      );
    } catch (e) {
      // malformatted input, returning false
      return false;
    }
  };
}

function arrayAny(
  value: any,
  array: unknown,
  fn: (value: any, otherValue: any) => boolean,
): boolean {
  if (!Array.isArray(array)) {
    return false;
  }
  for (let i = 0; i < array.length; i++) {
    if (fn(value, array[i])) {
      return true;
    }
  }
  return false;
}

function arrayHasValue(value: unknown[], target: string[] | number[]): boolean {
  const valueSet = new Set(value);
  for (let i = 0; i < target.length; i++) {
    if (
      valueSet.has(target[i]) ||
      valueSet.has(parseInt(target[i] as string))
    ) {
      return true;
    }
  }
  return false;
}

function arrayHasAllValues(
  value: unknown[],
  target: string[] | number[],
): boolean {
  const valueSet = new Set(value);
  for (let i = 0; i < target.length; i++) {
    if (
      !valueSet.has(target[i]) &&
      !valueSet.has(parseInt(target[i] as string))
    ) {
      return false;
    }
  }
  return true;
}
