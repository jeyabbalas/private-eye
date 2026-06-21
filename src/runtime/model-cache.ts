/**
 * Persistent CacheStorage for the large, cross-origin model WEIGHTS that the Quick
 * Read pipeline streams from the HuggingFace CDN on every load (the PP-OCRv6 det/rec
 * graphs, SLANet, and the 130 MB PP-DocLayoutV3 external-data file). Without this they
 * ride only the browser HTTP cache, which is unreliable for files this large and
 * cross-origin — browsers cap per-resource/total cache size and evict large entries,
 * and HF's `…/resolve/main/…` URLs 302-redirect to signed CDN URLs that change between
 * sessions, so the URL-keyed HTTP cache usually misses. The net effect is a returning
 * user re-downloading ~275 MB. CacheStorage gives an app-controlled, durable copy keyed
 * by the stable original URL — the Quick Read mirror of the OPFS cache Deep Read already
 * uses for its GGUF weights (src/runtime/run-g-live.ts). Same-origin vendored assets are
 * small and stay on the normal HTTP cache; see isRemote().
 *
 * PRIVACY: only PUBLIC model weights are cached — no document, image, or OCR bytes ever
 * reach here. The miss-path fetch uses `cache:'no-store'` so the HTTP cache keeps no
 * duplicate; CacheStorage holds the single persistent copy (mirrors vlm-download.worker).
 *
 * Isomorphic: `caches`, `self.location.origin`, and `navigator.storage` exist on both
 * the main thread and in Web Workers, so the worker-side adapter (which fetches the
 * weights) and the main-thread boot (which GCs + requests durable storage) share one
 * per-origin cache bucket.
 */

/** Bump this version to invalidate the cache (e.g. when the default OCR tier changes,
 *  or when the model source URLs change — mirroring/pinning the HF weights; see
 *  SOURCES in src/runtime/assets.ts); prepareModelCache() drops any older
 *  `private-eye-models-*` bucket on the next boot. */
const CACHE = 'private-eye-models-v1';

/** The adapter's fetch (with retry/backoff), parameterised so the miss path can request
 *  `cache:'no-store'`. */
type Fetcher = (url: string, init?: RequestInit) => Promise<Uint8Array>;

function cacheStorageAvailable(): boolean {
  return typeof caches !== 'undefined';
}

/** True ONLY for cross-origin http(s) URLs — the HuggingFace CDN weights. Same-origin
 *  vendored files, plus `blob:`/`data:` inputs, return false and skip the persistent
 *  cache (they're small and the normal HTTP cache handles them). */
export function isRemote(url: string): boolean {
  try {
    const u = new URL(url, self.location.origin);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin !== self.location.origin;
  } catch {
    return false;
  }
}

/** Return the weight bytes for `url`: served from CacheStorage when present, otherwise
 *  fetched via `fetcher` and stored for next time. Degrades to a plain fetch whenever
 *  CacheStorage is unavailable or unwritable (private mode, storage disabled) — caching
 *  must never be the reason a model fails to load. */
export async function cachedModelBytes(url: string, fetcher: Fetcher): Promise<Uint8Array> {
  if (!cacheStorageAvailable()) return fetcher(url);
  let cache: Cache;
  try {
    cache = await caches.open(CACHE);
  } catch {
    return fetcher(url);
  }

  const hit = await cache.match(url).catch(() => undefined);
  if (hit) return new Uint8Array(await hit.arrayBuffer());

  // Miss: a single network copy, with no HTTP-cache duplicate — CacheStorage is the one
  // persistent copy.
  const bytes = await fetcher(url, { cache: 'no-store' });
  // HF's resolve/main 302-redirects, and cache.put() REJECTS a redirected Response — so
  // store a freshly-constructed Response under the stable original URL. Best-effort: a
  // full or unavailable cache must not fail the load (we already hold the bytes).
  try {
    // A Uint8Array is a valid Response body at runtime; the cast sidesteps TS 5.7's
    // stricter ArrayBufferLike typing on BufferSource (avoids copying the bytes).
    await cache.put(
      url,
      new Response(bytes as BodyInit, { headers: { 'Content-Length': String(bytes.byteLength), 'Content-Type': 'application/octet-stream' } }),
    );
  } catch {
    /* quota reached / cache unavailable — serve uncached */
  }
  return bytes;
}

/** Best-effort, idempotent, call once at app boot (main thread): request durable storage
 *  so the cached weights survive eviction — covering a Quick-Read-only user, since Deep
 *  Read's ensurePersistentStorage() only runs once that pipeline loads — and drop any
 *  stale model cache left by an earlier CACHE version. Never throws. */
export async function prepareModelCache(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* persist() unavailable (e.g. worker scope) */
  }
  if (!cacheStorageAvailable()) return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('private-eye-models-') && k !== CACHE).map((k) => caches.delete(k)));
  } catch {
    /* enumeration/deletion unavailable */
  }
}
