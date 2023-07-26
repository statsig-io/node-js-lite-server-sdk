import * as statsigsdk from '../index';
import StatsigInstanceUtils from '../StatsigInstanceUtils';
import StatsigTestUtils from './StatsigTestUtils';
// @ts-ignore
const statsig = statsigsdk.default;

const exampleConfigSpecs = require('./jest.setup');

const jsonResponse = {
  time: Date.now(),
  feature_gates: [exampleConfigSpecs.gate, exampleConfigSpecs.disabled_gate],
  dynamic_configs: [exampleConfigSpecs.config],
  layer_configs: [exampleConfigSpecs.allocated_layer],
  has_updates: true,
};

jest.mock('node-fetch', () => jest.fn());
// @ts-ignore
const fetch = require('node-fetch');
// @ts-ignore
fetch.mockImplementation((url, params) => {
  if (url.includes('download_config_specs')) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(jsonResponse),
      text: () => Promise.resolve(JSON.stringify(jsonResponse)),
    });
  }
  if (url.includes('get_id_lists')) {
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({
          list_1: {
            name: 'list_1',
            size: 15,
            url: 'https://id_list_content/list_1',
            fileID: 'file_id_1',
            creationTime: 1,
          },
        }),
    });
  }
  return Promise.reject();
});

describe('Verify sync intervals reset', () => {
  const secretKey = 'secret-key';
  const str_64 =
    '1234567890123456789012345678901234567890123456789012345678901234';
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    jest.useFakeTimers();

    StatsigInstanceUtils.setInstance(null);
  });

  test('Verify timers reset if rulesets stale', async () => {
    await statsig.initialize(secretKey);
    let now = Date.now();

    const evaluator = StatsigTestUtils.getEvaluator();
    const spyRulesetsSync = jest.spyOn(evaluator['store'], 'syncValues');
    const spyIdListsSync = jest.spyOn(evaluator['store'], 'syncIdLists');

    let gate = await statsig.checkGate(
      { userID: '123', email: 'tore@packers.com' },
      'nfl_gate',
    );
    expect(gate).toBe(true);
    expect(spyRulesetsSync).toHaveBeenCalledTimes(0);
    expect(spyIdListsSync).toHaveBeenCalledTimes(0);

    jest
      .spyOn(global.Date, 'now')
      .mockImplementation(() => now + (2 * 60 * 1000 - 100));
    gate = await statsig.checkGate(
      { userID: '123', email: 'tore@packers.com' },
      'nfl_gate',
    );
    expect(gate).toBe(true);
    expect(spyRulesetsSync).toHaveBeenCalledTimes(0);
    expect(spyIdListsSync).toHaveBeenCalledTimes(0);

    jest
      .spyOn(global.Date, 'now')
      .mockImplementation(() => now + (2 * 60 * 1000 + 1));
    gate = await statsig.checkGate(
      { userID: '123', email: 'tore@packers.com' },
      'nfl_gate',
    );
    expect(gate).toBe(true);
    expect(spyRulesetsSync).toHaveBeenCalledTimes(1);
    expect(spyIdListsSync).toHaveBeenCalledTimes(1);
  });

  test('Verify timers dont reset if syncing is disabled', async () => {
    await statsig.initialize(secretKey, {
      disableRulesetsSync: true,
      disableIdListsSync: true,
    });
    let now = Date.now();

    const evaluator = StatsigTestUtils.getEvaluator();
    const spyRulesetsSync = jest.spyOn(evaluator['store'], 'syncValues');
    const spyIdListsSync = jest.spyOn(evaluator['store'], 'syncIdLists');

    jest
      .spyOn(global.Date, 'now')
      .mockImplementation(() => now + (2 * 60 * 1000 + 1));
    const gate = await statsig.checkGate(
      { userID: '123', email: 'tore@packers.com' },
      'nfl_gate',
    );
    expect(gate).toBe(true);
    expect(spyRulesetsSync).toHaveBeenCalledTimes(0);
    expect(spyIdListsSync).toHaveBeenCalledTimes(0);
  });
});
