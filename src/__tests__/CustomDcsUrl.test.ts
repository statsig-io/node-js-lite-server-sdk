import { OptionsWithDefaults } from '../StatsigOptions';
import StatsigServer from '../StatsigServer';

const jsonResponse = {
  time: Date.now(),
  feature_gates: [],
  dynamic_configs: [],
  layer_configs: [],
  has_updates: true,
};
const dcsPath = '/download_config_specs/secret-123.json';
const customUrl = 'custom_download_config_specs_url';
const defaultDcsUrl = 'https://api.statsigcdn.com/v2';
const configuredV1Url = 'https://statsigcdn.openai.com/v1';
const configuredV2Url = 'https://statsigcdn.openai.com/v2';

function mockRequest(statsigServer: StatsigServer) {
  return jest
    // @ts-ignore
    .spyOn(statsigServer._fetcher, 'request')
    .mockImplementation(() => {
      return Promise.resolve(
        new Response(JSON.stringify(jsonResponse), { status: 200 }),
      );
    });
}

describe('Check custom DCS url', () => {
  const options = OptionsWithDefaults({
    apiForDownloadConfigSpecs: customUrl,
  });
  const statsigServer = new StatsigServer('secret-123', options);

  const spy = mockRequest(statsigServer);

  it('works', async () => {
    await statsigServer.initializeAsync();
    statsigServer.logEvent({ userID: '42' }, 'test');
    await statsigServer.flush();

    expect(spy).toHaveBeenCalledWith(
      'GET',
      customUrl + dcsPath,
      undefined,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    expect(spy).not.toHaveBeenCalledWith(
      customUrl + '/get_id_lists',
      expect.anything(),
    );
    expect(spy).not.toHaveBeenCalledWith(
      customUrl + '/log_event',
      expect.anything(),
    );

    spy.mock.calls.forEach((u) => {
      if (u[0].endsWith(dcsPath) && u[0] != customUrl + dcsPath) {
        fail('download_config_spec should not be called on another base url');
      }
    });
  });
});

describe('Check default DCS url', () => {
  it('uses the v2 download_config_specs endpoint', async () => {
    const statsigServer = new StatsigServer('secret-123');
    const spy = mockRequest(statsigServer);

    await statsigServer.initializeAsync();

    expect(spy).toHaveBeenCalledWith(
      'GET',
      defaultDcsUrl + dcsPath,
      undefined,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    statsigServer.shutdown();
  });
});

describe('Check configured v1 DCS urls', () => {
  it.each([
    ['api', { api: configuredV1Url }],
    [
      'apiForDownloadConfigSpecs',
      { apiForDownloadConfigSpecs: configuredV1Url },
    ],
  ])('uses v2 when %s points to v1', async (_, options) => {
    const statsigServer = new StatsigServer(
      'secret-123',
      OptionsWithDefaults({
        ...options,
        disableIdListsSync: true,
      }),
    );
    const spy = mockRequest(statsigServer);

    await statsigServer.initializeAsync();

    expect(spy).toHaveBeenCalledWith(
      'GET',
      configuredV2Url + dcsPath,
      undefined,
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );

    statsigServer.shutdown();
  });
});
