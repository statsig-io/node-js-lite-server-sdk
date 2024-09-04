import { SecondaryExposure } from './LogEvent';

export type FeatureGate = {
  readonly name: string;
  readonly ruleID: string;
  readonly groupName: string | null;
  readonly value: boolean;
  readonly secondaryExposures: SecondaryExposure[];
};

export function makeFeatureGate(
  name: string,
  ruleID: string,
  value: boolean,
  groupName: string | null,
  secondaryExposures: SecondaryExposure[],
): FeatureGate {
  return { name, ruleID, value, groupName, secondaryExposures };
}

export function makeEmptyFeatureGate(name: string): FeatureGate {
  return {
    name,
    ruleID: '',
    value: false,
    groupName: null,
    secondaryExposures: [],
  };
}
