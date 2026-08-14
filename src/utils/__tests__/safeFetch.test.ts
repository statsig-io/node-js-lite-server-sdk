const globalScope = globalThis as any;

function loadSafeFetch() {
  let safeFetch: (...args: any[]) => Promise<any>;
  jest.isolateModules(() => {
    safeFetch = require('../safeFetch').default;
  });
  // @ts-ignore assigned by the isolated require above
  return safeFetch;
}

describe('safeFetch', () => {
  afterEach(() => {
    globalScope.fetch = undefined;
    jest.dontMock('node-fetch');
    jest.resetModules();
  });

  it('uses the fetch the runtime provides', async () => {
    const runtimeFetch = jest.fn().mockResolvedValue('runtime');
    const nodeFetch = jest.fn().mockResolvedValue('node-fetch');
    globalScope.fetch = runtimeFetch;
    jest.doMock('node-fetch', () => nodeFetch);

    await expect(loadSafeFetch()('https://statsig.com')).resolves.toEqual(
      'runtime',
    );

    expect(runtimeFetch).toHaveBeenCalledWith('https://statsig.com');
    expect(nodeFetch).not.toHaveBeenCalled();
  });

  it('falls back to node-fetch when the runtime has none', async () => {
    const nodeFetch = jest.fn().mockResolvedValue('node-fetch');
    globalScope.fetch = undefined;
    jest.doMock('node-fetch', () => nodeFetch);

    await expect(loadSafeFetch()('https://statsig.com')).resolves.toEqual(
      'node-fetch',
    );

    expect(nodeFetch).toHaveBeenCalledWith('https://statsig.com');
  });

  it('unwraps a node-fetch that exports itself as default', async () => {
    const nodeFetch = jest.fn().mockResolvedValue('node-fetch-default');
    globalScope.fetch = undefined;
    jest.doMock('node-fetch', () => ({ default: nodeFetch }));

    await expect(loadSafeFetch()('https://statsig.com')).resolves.toEqual(
      'node-fetch-default',
    );

    expect(nodeFetch).toHaveBeenCalledWith('https://statsig.com');
  });
});
