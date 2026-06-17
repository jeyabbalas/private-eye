/**
 * Logging facade — the console is SILENT by default (Private Eye is consumer
 * facing; we never spam the browser console). Add `?debug=1` to the URL to
 * re-enable the prototype-level diagnostics for a bug report. In a Web Worker
 * the page query string isn't visible, so the worker entry forwards the flag
 * via setDebug().
 */
let DEBUG = (() => {
  try {
    return new URLSearchParams(self.location.search).has('debug');
  } catch {
    return false;
  }
})();

let lastError: unknown = null;

export function setDebug(v: boolean): void {
  DEBUG = v;
}

export function isDebug(): boolean {
  return DEBUG;
}

/** The most recent error, captured even when DEBUG is off, for the modal. */
export function getLastError(): unknown {
  return lastError;
}

export const log = {
  debug(...args: unknown[]): void {
    if (DEBUG) console.debug('[private-eye]', ...args);
  },
  warn(...args: unknown[]): void {
    if (DEBUG) console.warn('[private-eye]', ...args);
  },
  error(err: unknown): void {
    lastError = err;
    if (DEBUG) console.error('[private-eye]', err);
  },
};
