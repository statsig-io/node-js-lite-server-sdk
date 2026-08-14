// @ts-ignore
let nodeFetch: (...args) => Promise<Response> = null;
// node-fetch is only a fallback for runtimes without their own fetch: it routes every
// request through the deprecated url.parse(), so on Node 18+ it costs consumers a
// DEP0169 warning per process for a polyfill they do not need.
// https://github.com/statsig-io/node-js-lite-server-sdk/issues/3
// @ts-ignore
if (typeof EdgeRuntime !== 'string' && typeof fetch !== 'function') {
  try {
    nodeFetch = require('node-fetch');
    const nfDefault = (nodeFetch as any).default;
    if (nfDefault && typeof nfDefault === 'function') {
      nodeFetch = nfDefault;
    }
  } catch (err) {
    // Ignore
  }
}

// @ts-ignore
export default function safeFetch(...args): Promise<Response> {
  if (nodeFetch) {
    return nodeFetch(...args);
  } else {
    // @ts-ignore
    return fetch(...args);
  }
}
