/**
 * Memory hygiene helpers for the "one page at a time, never crash the browser"
 * invariant. The queue processes a single page's working set, then frees it; the
 * primitives here make that freeing automatic and the heap observable in debug.
 */

interface JsHeap {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

/** Non-standard Chrome heap readout for the `?debug=1` log / technical block. */
export function memText(): string {
  const m = (performance as Performance & { memory?: JsHeap }).memory;
  if (!m) return 'heap n/a';
  const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
  return `heap ${mb(m.usedJSHeapSize)} / ${mb(m.jsHeapSizeLimit)}`;
}

/**
 * Run `fn` with a fresh object URL for `blob`, revoking it afterward no matter
 * what. This is how the page working set is kept to exactly one raster at a time:
 * the URL exists only for the duration of the read.
 */
export async function withObjectUrl<T>(blob: Blob, fn: (url: string) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(blob);
  try {
    return await fn(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
