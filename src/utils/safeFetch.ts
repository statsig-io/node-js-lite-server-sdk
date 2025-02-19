// @ts-ignore
let nodeFetch: (...args) => Promise<Response> = null;
// @ts-ignore
if (typeof EdgeRuntime !== 'string') {
  try {
    const obj = require('node-fetch');
    if (typeof obj === 'function') {
      nodeFetch = obj;
    } else if (typeof obj.default === 'function') {
      nodeFetch = obj.default;
    }
  } catch (err) {
    // Ignore
  }
}

// @ts-ignore
export default function safeFetch(...args): Promise<Response> {
  if (nodeFetch) {
    return nodeFetch(...args);
  }
  // @ts-ignore
  return fetch(...args);
}
