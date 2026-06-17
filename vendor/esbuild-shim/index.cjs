// CommonJS counterpart of index.mjs (for any `require('esbuild')` callers).
const wasm = require('esbuild-wasm');

let initPromise;
const ensureInit = () => (initPromise ??= wasm.initialize({}));

module.exports = {
  version: wasm.version,
  transform: async (...args) => {
    await ensureInit();
    return wasm.transform(...args);
  },
  build: async (...args) => {
    await ensureInit();
    return wasm.build(...args);
  },
  context: async (...args) => {
    await ensureInit();
    return wasm.context(...args);
  },
  formatMessages: async (...args) => {
    await ensureInit();
    return wasm.formatMessages(...args);
  },
  analyzeMetafile: async (...args) => {
    await ensureInit();
    return wasm.analyzeMetafile(...args);
  },
  initialize: (...args) => (initPromise ??= wasm.initialize(...args)),
  stop: typeof wasm.stop === 'function' ? wasm.stop : () => {},
};
