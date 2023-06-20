import { IDataAdapter } from './interfaces/IDataAdapter';

const DEFAULT_API = 'https://statsigapi.net/v1';
const DEFAULT_RULESETS_SYNC_INTERVAL = 10 * 1000;
const MIN_RULESETS_SYNC_INTERVAL = 5 * 1000;
const DEFAULT_ID_LISTS_SYNC_INTERVAL = 60 * 1000;
const MIN_ID_LISTS_SYNC_INTERVAL = 30 * 1000;
const DEFAULT_LOGGING_INTERVAL = 60 * 1000;
const DEFAULT_MAX_LOGGING_BUFFER_SIZE = 1000;
const DEFAULT_LOG_DIAGNOSTICS = false;
const DEFAULT_POST_LOGS_RETRY_LIMIT = 5;
const DEFAULT_POST_LOGS_RETRY_BACKOFF = 1000;

export type RulesUpdatedCallback = (rulesJSON: string, time: number) => void;
export type RetryBackoffFunc = (retriesRemaining: number) => number;

export type StatsigEnvironment = {
  tier?: 'production' | 'staging' | 'development' | string;
  [key: string]: string | undefined;
};

export type InitStrategy = 'await' | 'lazy' | 'none';

export interface LoggerInterface {
  warn(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
}

export type ExplicitStatsigOptions = {
  api: string;
  apiForDownloadConfigSpecs: string | null;
  bootstrapValues: string | null;
  environment: StatsigEnvironment | null;
  rulesUpdatedCallback: RulesUpdatedCallback | null;
  logger: LoggerInterface;
  localMode: boolean;
  initTimeoutMs: number;
  dataAdapter: IDataAdapter | null;
  rulesetsSyncIntervalMs: number;
  idListsSyncIntervalMs: number;
  loggingIntervalMs: number;
  loggingMaxBufferSize: number;
  disableDiagnostics: boolean;
  initStrategyForIP3Country: InitStrategy;
  initStrategyForIDLists: InitStrategy;
  postLogsRetryLimit: number;
  postLogsRetryBackoff: RetryBackoffFunc | number;
};

/**
 * An object of properties for initializing the sdk with advanced options
 */
export type StatsigOptions = Partial<ExplicitStatsigOptions>;

export function OptionsWithDefaults(
  opts: StatsigOptions,
): ExplicitStatsigOptions {
  return {
    api: normalizeUrl(
      getString(opts, 'api', DEFAULT_API) ?? DEFAULT_API,
    ) as string,
    apiForDownloadConfigSpecs: normalizeUrl(
      getString(opts, 'apiForDownloadConfigSpecs', null),
    ),
    bootstrapValues: getString(opts, 'bootstrapValues', null),
    environment: opts.environment
      ? (getObject(opts, 'environment', {}) as StatsigEnvironment)
      : null,
    rulesUpdatedCallback: opts.rulesUpdatedCallback
      ? (getFunction(opts, 'rulesUpdatedCallback') as RulesUpdatedCallback)
      : null,
    localMode: getBoolean(opts, 'localMode', false),
    initTimeoutMs: getNumber(opts, 'initTimeoutMs', 0),
    logger: opts.logger ?? console,
    dataAdapter: opts.dataAdapter ?? null,
    rulesetsSyncIntervalMs: Math.max(
      getNumber(opts, 'rulesetsSyncIntervalMs', DEFAULT_RULESETS_SYNC_INTERVAL),
      MIN_RULESETS_SYNC_INTERVAL,
    ),
    idListsSyncIntervalMs: Math.max(
      getNumber(opts, 'idListsSyncIntervalMs', DEFAULT_ID_LISTS_SYNC_INTERVAL),
      MIN_ID_LISTS_SYNC_INTERVAL,
    ),
    loggingIntervalMs: getNumber(
      opts,
      'loggingIntervalMs',
      DEFAULT_LOGGING_INTERVAL,
    ),
    loggingMaxBufferSize: Math.min(
      getNumber(opts, 'loggingMaxBufferSize', DEFAULT_MAX_LOGGING_BUFFER_SIZE),
      DEFAULT_MAX_LOGGING_BUFFER_SIZE,
    ),
    disableDiagnostics: getBoolean(
      opts,
      'disableDiagnostics',
      DEFAULT_LOG_DIAGNOSTICS,
    ),
    initStrategyForIP3Country:
      (getString(
        opts,
        'initStrategyForIP3Country',
        'await',
      ) as InitStrategy | null) ?? 'await',
    initStrategyForIDLists:
      (getString(
        opts,
        'initStrategyForIDLists',
        'await',
      ) as InitStrategy | null) ?? 'await',
    postLogsRetryLimit: getNumber(
      opts,
      'postLogsRetryLimit',
      DEFAULT_POST_LOGS_RETRY_LIMIT,
    ),
    postLogsRetryBackoff:
      opts.postLogsRetryBackoff ?? DEFAULT_POST_LOGS_RETRY_BACKOFF,
  };
}

function getBoolean(
  inputOptions: Record<string, unknown>,
  index: string,
  defaultValue: boolean,
): boolean {
  const b = inputOptions[index];
  if (b == null || typeof b !== 'boolean') {
    return defaultValue;
  }
  return b;
}

function getString(
  inputOptions: Record<string, unknown>,
  index: string,
  defaultValue: string | null,
): string | null {
  const str = inputOptions[index];
  if (str == null || typeof str !== 'string') {
    return defaultValue;
  }
  return str;
}

function getObject(
  inputOptions: Record<string, unknown>,
  index: string,
  defaultValue: Record<string, undefined>,
): Record<string, unknown> {
  const obj = inputOptions[index];
  if (obj == null || typeof obj !== 'object') {
    return defaultValue;
  }
  return obj as Record<string, unknown>;
}

function getFunction(inputOptions: Record<string, unknown>, index: string) {
  const func = inputOptions[index];
  if (func == null || typeof func !== 'function') {
    return null;
  }
  return func;
}

function getNumber(
  inputOptions: Record<string, unknown>,
  index: string,
  defaultValue: number,
): number {
  const obj = inputOptions[index];
  if (obj == null || typeof obj !== 'number') {
    return defaultValue;
  }
  return obj;
}

function normalizeUrl(url: string | null): string | null {
  return url && url.endsWith('/') ? url.slice(0, -1) : url;
}
