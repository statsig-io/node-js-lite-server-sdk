import { EvaluationDetails } from './EvaluationDetails';
import { SecondaryExposure } from './LogEvent';

export default class ConfigEvaluation {
  public value: boolean;
  public rule_id: string;
  public secondary_exposures: SecondaryExposure[];
  public json_value: Record<string, unknown>;
  public explicit_parameters: string[] | null;
  public config_delegate: string | null;
  public unsupported: boolean;
  public undelegated_secondary_exposures: SecondaryExposure[] | undefined;
  public is_experiment_group: boolean;
  public group_name: string | null;
  public evaluation_details: EvaluationDetails | undefined;
  public configVersion?: number | undefined;

  constructor(
    value: boolean,
    rule_id = '',
    group_name: string | null = null,
    secondary_exposures: SecondaryExposure[] = [],
    json_value: Record<string, unknown> | boolean = {},
    explicit_parameters: string[] | null = null,
    config_delegate: string | null = null,
    configVersion?: number,
    unsupported = false,
  ) {
    this.value = value;
    this.rule_id = rule_id;
    if (typeof json_value === 'boolean') {
      // handle legacy gate case
      this.json_value = {};
    } else {
      this.json_value = json_value;
    }
    this.secondary_exposures = secondary_exposures;
    this.undelegated_secondary_exposures = secondary_exposures;
    this.config_delegate = config_delegate;
    this.unsupported = unsupported;
    this.explicit_parameters = explicit_parameters;
    this.is_experiment_group = false;
    this.group_name = group_name;
    this.configVersion = configVersion;
  }

  public withEvaluationDetails(
    evaulationDetails: EvaluationDetails,
  ): ConfigEvaluation {
    this.evaluation_details = evaulationDetails;
    return this;
  }

  public setIsExperimentGroup(isExperimentGroup = false) {
    this.is_experiment_group = isExperimentGroup;
  }

  public static unsupported(
    configSyncTime: number,
    initialUpdateTime: number,
    version: number | undefined,
  ) {
    return new ConfigEvaluation(
      false,
      '',
      null,
      [],
      {},
      undefined,
      undefined,
      version,
      true,
    ).withEvaluationDetails(
      EvaluationDetails.unsupported(configSyncTime, initialUpdateTime),
    );
  }
}
