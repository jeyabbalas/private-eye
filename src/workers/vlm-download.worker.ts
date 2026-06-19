/// <reference lib="webworker" />
/**
 * Deep Read weight downloader — a tiny, dependency-free Web Worker whose only job
 * is to stream the public GLM-OCR GGUF weights from the HuggingFace CDN straight
 * into OPFS using createSyncAccessHandle().
 *
 * Why a worker, and why this exact API — three reasons, all independent of any
 * machine quirk:
 *   1. createSyncAccessHandle() exists ONLY in workers.
 *   2. It writes IN PLACE — no `.crswap` swap file. The main thread's
 *      FileSystemFileHandle.createWritable() stages every write through a swap file
 *      that is atomically renamed on close, transiently reserving up to ~2× the file
 *      size against the origin's quota; the in-place handle needs only 1×.
 *   3. `cache:'no-store'` keeps no HTTP-cache duplicate of the cross-origin weights,
 *      so OPFS holds the single copy (and nothing lingers in the cache — see PRIVACY).
 * wllama's own loader writes weights exactly this way (its OPFS_UTILS_WORKER_CODE uses
 * createSyncAccessHandle in a worker); this worker replicates it with public APIs only.
 * (The QuotaExceededError wall chased during bring-up was an incognito-window artifact —
 * private browsing grants a small, fluctuating OPFS quota; a normal window holds the full
 * ~1.37 GB fine, exactly as the prototype always did on this same machine.)
 *
 * The bytes land in OPFS; the main thread reads them back as OPFS-backed Files for
 * wllama's loadModel (the prototype's proven read path).
 *
 * PRIVACY: the only network traffic is the inbound GET of the public model weights
 * (`cache:'no-store'`, so nothing is even left in the HTTP cache). This worker never
 * sees document bytes — it only fetches public weights and writes them to OPFS.
 */

const ctx = self as DedicatedWorkerGlobalScope;

/** createSyncAccessHandle() is worker-only and absent from this TS lib's handle
 *  type — a minimal local surface keeps the call typed without depending on lib drift. */
interface SyncAccessHandle {
  truncate(newSize: number): void;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

interface DownloadFile {
  name: string;
  url: string;
  /** Advertised byte length (HEAD content-length); 0 = unknown (skip the truncation check). */
  expectedSize: number;
}
type ToWorker = { type: 'download'; dirName: string; files: DownloadFile[] } | { type: 'cancel' };
type FromWorker = { type: 'progress'; delta: number } | { type: 'done' } | { type: 'error'; message: string };

function post(msg: FromWorker): void {
  ctx.postMessage(msg);
}

/** The in-flight download's abort handle, so a 'cancel' message stops the fetch
 *  (which rejects the read loop and closes the OPFS handle via its finally). */
let controller: AbortController | null = null;

/** Stream one public weight file from the CDN into OPFS, in place, via
 *  createSyncAccessHandle — writing at an explicit running offset (no reliance on
 *  the handle's implicit cursor). */
async function downloadOne(dir: FileSystemDirectoryHandle, file: DownloadFile, signal: AbortSignal): Promise<void> {
  const res = await fetch(file.url, { cache: 'no-store', signal });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${file.name}`);
  const fileHandle = await dir.getFileHandle(file.name, { create: true });
  const access = await (fileHandle as unknown as { createSyncAccessHandle(): Promise<SyncAccessHandle> }).createSyncAccessHandle();
  let fetched = 0; // bytes delivered by the network stream
  let written = 0; // bytes actually persisted to OPFS (write() returns a short count on quota)
  try {
    access.truncate(0); // start from an empty file — drop any leftover bytes
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fetched += value.byteLength;
      const n = access.write(value, { at: written }); // in-place write at the running offset
      written += n;
      post({ type: 'progress', delta: n });
      // createSyncAccessHandle.write() does NOT throw on quota — it persists what fits and
      // returns the short count. A short write therefore means OPFS is full; surface it
      // loudly (with the byte counts) instead of silently truncating the file.
      if (n < value.byteLength) {
        throw new Error(`OPFS quota reached writing ${file.name}: persisted ${written} B (last chunk ${n}/${value.byteLength}), ${fetched} B fetched`);
      }
    }
    access.flush();
  } finally {
    access.close(); // releases the exclusive OPFS lock so the main thread can read
  }
  // A clean end-of-stream short of the advertised size means the download itself truncated
  // (a CDN/network cut), not OPFS — distinct from the short-write case above.
  if (file.expectedSize > 0 && fetched !== file.expectedSize) {
    throw new Error(`truncated download of ${file.name}: ${fetched} of ${file.expectedSize} B fetched`);
  }
}

async function download(dirName: string, files: DownloadFile[]): Promise<void> {
  controller = new AbortController();
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirName, { create: true });
  for (const file of files) await downloadOne(dir, file, controller.signal);
  post({ type: 'done' });
}

ctx.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'cancel') {
    controller?.abort();
    return;
  }
  if (msg.type === 'download') {
    download(msg.dirName, msg.files).catch((err: unknown) => {
      post({ type: 'error', message: String((err as Error)?.message ?? err) });
    });
  }
};
