// Routes `import ... from 'esbuild'` to esbuild-wasm, lazily initializing the
// WASM service on first use (Vite never calls initialize() itself). Methods are
// invoked on the esbuild-wasm namespace so their receiver is preserved.
import * as wasm from 'esbuild-wasm';

let initPromise;
const ensureInit = () => (initPromise ??= wasm.initialize({}));

export const version = wasm.version;
export const transform = async (...args) => {
  await ensureInit();
  return wasm.transform(...args);
};
export const build = async (...args) => {
  await ensureInit();
  return wasm.build(...args);
};
export const context = async (...args) => {
  await ensureInit();
  return wasm.context(...args);
};
export const formatMessages = async (...args) => {
  await ensureInit();
  return wasm.formatMessages(...args);
};
export const analyzeMetafile = async (...args) => {
  await ensureInit();
  return wasm.analyzeMetafile(...args);
};
export const initialize = (...args) => (initPromise ??= wasm.initialize(...args));
export const stop = typeof wasm.stop === 'function' ? wasm.stop : () => {};

export default { version, transform, build, context, formatMessages, analyzeMetafile, initialize, stop };
