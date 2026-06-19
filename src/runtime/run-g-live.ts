/**
 * Pipeline G live runner for the manual-test app: the same client-side chain
 * as the eval harness VLM probe in --live-crops mode — LayoutEngine + PpocrEngine
 * in-page, buildExportRegions crops, GLM-OCR Q8_0 per-region decode under the
 * memory-patched wllama, buildDocFromReplay assembly with numeric anchoring.
 *
 * Every decode-relevant rail (prompts, budgets, crop prep, greedy options,
 * repeat containment, assembly, anchoring) is imported from src/ or copied
 * verbatim from the probe so results match the P12 spike; this module only
 * adds UI progress hooks, an in-memory decode cache (gmode-toggle reuse) and
 * user cancellation. The model and the deterministic engines stay resident
 * across runs — the sequential-batch posture the app exists to exercise.
 */
import type { ChatCompletionChunk, Wllama } from '@wllama/wllama/esm/index.js';
import { createBrowserContext } from '../adapters/browser.ts';
import type { ModelSpec } from '../adapters/types.ts';
import type { RasterImage } from '../core/types.ts';
import { LAYOUT_MODEL_SPEC, LayoutEngine } from '../engines/layout/index.ts';
import { PPOCR_DEFAULTS, PpocrEngine, detModelSpec, recModelSpec } from '../engines/ppocr/index.ts';
import { renderMarkdown, type DocModel } from '../structure/blocks.ts';
import { buildDocFromReplay, type GAssembleStats, type GMode } from '../structure/vlmregion/assemble.ts';
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import type { VerificationResult } from '../structure/verify.ts';
import { buildExportRegions } from '../structure/vlmregion/export.ts';
import { prepCropPolicy } from '../structure/vlmregion/prep.ts';
import { promptFor, taskOf, tokenBudget, truncateRepeats, vlmPromptConfig } from '../structure/vlmregion/prompts.ts';
import type { ExportPage, VlmRegionOut } from '../structure/vlmregion/replay.ts';
import { GLM_OCR_MODEL_URL, GLM_OCR_MMPROJ_URL, WLLAMA_INDEX_URL, WLLAMA_WASM_URL } from './assets.ts';
import { modelDownloadError } from './errors.ts';
import { getLastError, isDebug, log } from './logger.ts';

export type { GMode } from '../structure/vlmregion/assemble.ts';

type WllamaModule = typeof import('@wllama/wllama/esm/index.js');

// Deep Read VLM weights stream from the HuggingFace CDN (public weights only);
// the patched wllama runtime is vendored same-origin. See src/runtime/assets.ts.
const MODEL_URL = GLM_OCR_MODEL_URL;
const MMPROJ_URL = GLM_OCR_MMPROJ_URL;
/** OPFS subdirectory holding the streamed GGUF weights (model + mmproj). */
const VLM_DIR = 'private-eye-vlm';

interface ModelFileSpec {
  name: string;
  url: string;
  /** content-length from a HEAD probe; 0 if the CDN omits it (then reuse is skipped). */
  expectedSize: number;
}
/** Per-region decode deadline (the eval harness --max-time default). */
const MAX_TIME_S = 300;
/** Verbatim from the eval harness VLM probe EXPORT_OPTS — keep in sync. */
const EXPORT_OPTS = { layoutThresh: 0.5, tier: PPOCR_DEFAULTS.tier, detLimit: 960, dropScore: 0.5, geomDeflateY: 0.6, padPx: 8, minPx: 16 } as const;

const cfg = vlmPromptConfig('glm-ocr-q8'); // prefix-resolved: glm-ocr prompts, promptRev glm-g1

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export interface GProgress {
  onStatus(s: string): void;
  onLoadProgress?(loaded: number, total: number): void;
  onRegionStart?(i: number, n: number, kind: string): void;
  /** Cumulative streamed text of the in-flight region. */
  onToken?(textSoFar: string): void;
  onRegionEnd?(i: number, n: number, rec: VlmRegionOut, cached: boolean): void;
}

export interface GRunResult {
  markdown: string;
  /** The assembled document model the Markdown was rendered from. Carried so the
   *  review UI can render G's output block-by-block and link each block to its
   *  provenance (exactly as it does for E) — without it, a Deep Read result has
   *  no editable/linkable structure. */
  doc: DocModel;
  note: string;
  /** Surfaced for the human-in-the-loop review app: line-level OCR confidence,
   *  coverage gaps, and VLM-vs-OCR numeric disagreements (reviewItems). */
  uncertainty: UncertaintyLayer;
  /** Pipeline V verdict over the OCR reference ('pass' | 'review' | 'fallback');
   *  a 'fallback' verdict is the signal for app/run-doc.ts to route to E. */
  verification: VerificationResult;
  stats: GAssembleStats;
  stageMs: { layout: number; det: number; rec: number; vlm: number; structure: number };
  wallMs: number;
  decoded: number;
  cachedCount: number;
  regions: VlmRegionOut[];
}

// --- module state: model + engines resident across runs ---
export type AppEp = 'wasm' | 'webgpu';

let wllamaModule: WllamaModule | null = null;
let wllama: Wllama | null = null;
let loadedThreads = 0;
let loadedVlmEp: AppEp | null = null;
let vlmEpFallback = false; // webgpu requested but WebGPU absent / load crashed → wasm
let vlmLoadWarning: string | null = null; // low-device-memory advisory raised at load (gVlmNote)
let liveEngines: { layout: LayoutEngine; ocr: PpocrEngine; engineBytes: number; ep: AppEp } | null = null;
let epFallbacks: string[] = [];
let activeDocUrl: string | null = null; // the document currently held in the caches (LRU(1) bound)

/** "" until the deterministic engines loaded; reports the layout+OCR ONNX EP. */
export const gEpNote = (): string =>
  liveEngines
    ? `onnx ep: ${liveEngines.ep}${epFallbacks.length ? ` · fallback → wasm: ${epFallbacks.join('; ')}` : ''}`
    : '';

/** "" until the VLM is loaded; reports its EP (webgpu offloads the mtmd vision
 *  encoder — the P15 speedup lever), whether it fell back to wasm, and any
 *  low-device-memory advisory raised during load. */
export const gVlmNote = (): string =>
  wllama
    ? `vlm ep: ${loadedVlmEp}${vlmEpFallback ? ' (webgpu unavailable → wasm)' : ''}${vlmLoadWarning ? ` · ${vlmLoadWarning}` : ''}`
    : '';

interface LivePage {
  page: ExportPage;
  crops: Map<number, ArrayBuffer>; // region index -> PNG bytes
}
const livePageCache = new Map<string, LivePage>(); // image URL -> deterministic stage result
const decodeCache = new Map<string, VlmRegionOut>(); // regionKey-sha8 -> clean decode

/** Bound the per-document working set (deterministic-stage crops + decode
 *  outputs) to the active document — Pipeline G processes one document at a
 *  time, so holding prior documents' crops/outputs is unbounded by design over
 *  a long sequential batch (measured small per-doc, but it never stops growing).
 *  On a NEW document URL, drop the previous one; a re-run of the SAME document
 *  keeps the caches, preserving gmode-toggle / re-render reuse. */
function bindActiveDoc(imageUrl: string): void {
  if (activeDocUrl !== null && activeDocUrl !== imageUrl) {
    livePageCache.clear();
    decodeCache.clear();
  }
  activeDocUrl = imageUrl;
}

export const isGLoaded = (): boolean => wllama !== null;
export const gThreads = (): number => loadedThreads;

// Adapted from the eval harness VLM probe (sha256hex/decodePng/encodePng).
async function sha256hex(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function decodePng(bytes: ArrayBuffer): Promise<RasterImage> {
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const cx = canvas.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(bmp, 0, 0);
  const img = cx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { data: img.data, width: img.width, height: img.height };
}

async function encodePng(img: RasterImage): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const cx = canvas.getContext('2d')!;
  // Copy into a fresh buffer: ImageData rejects ArrayBufferLike-backed views.
  cx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

// Adapted from the eval harness VLM probe ensureLiveEngines. EP-aware: an EP
// switch disposes the EP-bound sessions and invalidates the deterministic-page
// cache (crops derive from layout/OCR outputs); the content-addressed
// decodeCache survives — identical crops decode identically by construction.
async function ensureLiveEngines(onStatus: (s: string) => void, ep: AppEp): Promise<NonNullable<typeof liveEngines>> {
  if (liveEngines?.ep === ep) return liveEngines;
  if (liveEngines) {
    await Promise.all([liveEngines.layout.dispose(), liveEngines.ocr.dispose()]);
    liveEngines = null;
    livePageCache.clear();
  }
  onStatus(`loading G deterministic engines (~155 MB: layout + det + rec) on ${ep}…`);
  epFallbacks = [];
  const ctx = createBrowserContext({
    ep,
    epFallback: true,
    onEpFallback: (id, requested, err) => {
      epFallbacks.push(`${id} (${String((err as Error)?.message ?? err).slice(0, 80)})`);
      log.warn(`[G] ${id}: ${requested} session failed, using wasm`, err);
    },
  });
  const layout = new LayoutEngine();
  const ocr = new PpocrEngine();
  await Promise.all([layout.init(ctx, { layoutThresh: EXPORT_OPTS.layoutThresh }), ocr.init(ctx, { ...PPOCR_DEFAULTS })]);
  let engineBytes = 0;
  const engineSpecs: ModelSpec[] = [LAYOUT_MODEL_SPEC, detModelSpec(PPOCR_DEFAULTS.tier), recModelSpec(PPOCR_DEFAULTS.tier)];
  for (const m of engineSpecs) {
    engineBytes += await ctx.assetSize(m.url).catch(() => 0);
    for (const ext of m.externalData ?? []) engineBytes += await ctx.assetSize(ext).catch(() => 0);
  }
  liveEngines = { layout, ocr, engineBytes, ep };
  return liveEngines;
}

/** Adapted from the eval harness VLM probe buildLivePage; the image URL is a
 *  parameter (and the cache key) so uploaded scans work, not just fixtures. */
async function buildLivePage(tag: string, imageUrl: string, onStatus: (s: string) => void, ep: AppEp): Promise<LivePage> {
  const eng = await ensureLiveEngines(onStatus, ep); // may clear livePageCache on EP switch
  let lp = livePageCache.get(imageUrl);
  if (lp) return lp;
  const ctx = createBrowserContext();
  onStatus(`deterministic stage: layout + OCR + crops (${ep === 'webgpu' ? '~3 s' : '~10 s'})…`);
  const image = await ctx.decodeImage(imageUrl);
  const { result: layoutRes, layoutMs } = await eng.layout.run(image);
  const { result: ocr, detMs, recMs } = await eng.ocr.run(image);
  const built = buildExportRegions(image, layoutRes.regions, ocr.lines, { pad: EXPORT_OPTS.padPx, minPx: EXPORT_OPTS.minPx });
  const crops = new Map<number, ArrayBuffer>();
  for (const [i, crop] of built.crops) crops.set(i, await encodePng(crop));
  const m = /^(.+)\.(\d+)$/.exec(tag);
  const page: ExportPage = {
    schema: 'g-regions/1',
    tag,
    fixture: m?.[1] ?? tag,
    page: Number(m?.[2] ?? 1),
    sourcePng: imageUrl,
    width: image.width,
    height: image.height,
    opts: { ...EXPORT_OPTS },
    stageMs: { layout: Math.round(layoutMs), det: Math.round(detMs), rec: Math.round(recMs) },
    engineBytes: eng.engineBytes,
    regions: built.regions,
    orphanLines: built.orphanLines,
  };
  lp = { page, crops };
  livePageCache.set(imageUrl, lp);
  return lp;
}

/** navigator.deviceMemory (coarse: one of 0.25/0.5/1/2/4/8 GiB, capped at 8 for
 *  privacy) vs the path's resident footprint — webgpu peaks ~1.8 GB, the wasm
 *  fallback ~4 GB (the eager mtmd vision buffer; measured 3.95 GB). Advisory
 *  only: the API is far too coarse to hard-block (the 8 GB cap can't tell 8 from
 *  64 GB) and a false refusal is worse than a warning. Returns null when the
 *  device looks fine or the API is unavailable. */
function preflightDeviceMemory(useGpu: boolean): string | null {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (dm === undefined) return null;
  const needGb = useGpu ? 2 : 8; // wasm's ~4 GB peak wants real headroom under the tab
  if (dm >= needGb) return null;
  return (
    `⚠ low memory: device reports ~${dm} GB RAM; GLM-OCR on ${useGpu ? 'webgpu' : 'wasm'} ` +
    `peaks ~${useGpu ? '1.8' : '4'} GB — close other tabs${useGpu ? '' : ' or use a WebGPU browser'} to avoid a crash`
  );
}

/** Route wllama's own diagnostics — including its nested workers' onerror, which
 *  wllama wires to `logger.error` — into our facade, so a swallowed worker failure
 *  is captured for the error modal (getLastError) and printed with ?debug=1,
 *  instead of vanishing into a suppressed logger and hanging the load. */
const wlLogger = {
  debug: (...a: unknown[]): void => log.debug('[wllama]', ...a),
  log: (...a: unknown[]): void => log.debug('[wllama]', ...a),
  warn: (...a: unknown[]): void => log.warn('[wllama]', ...a),
  error: (...a: unknown[]): void => log.error(a.length === 1 ? a[0] : a),
};

/** wllama's model load can hang with NO error and NO network when its nested
 *  workers fail to initialize inside a Web Worker (an Emscripten pthread-pool
 *  deadlock: the worker blocks in Atomics.wait waiting for sub-workers that never
 *  come up). Reject if no progress (download bytes) arrives within `stallMs`, so
 *  the infinite spinner becomes an actionable error we can fall back from. The
 *  watchdog runs in THIS (the Deep Read) worker, whose event loop is free while
 *  the deadlock sits in the child worker — so it always fires. */
const LOAD_STALL_MS = 60_000;
async function withStallWatchdog<T>(label: string, stallMs: number, run: (tick: () => void) => Promise<T>): Promise<T> {
  let last = performance.now();
  const tick = (): void => {
    last = performance.now();
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setInterval(() => {
      if (performance.now() - last > stallMs) {
        const le = getLastError();
        reject(
          modelDownloadError(
            `${label} stalled — no progress for ${Math.round(stallMs / 1000)}s`,
            le ? { lastWllamaError: String((le as Error)?.message ?? le).slice(0, 200) } : undefined,
          ),
        );
      }
    }, 5000);
  });
  try {
    return await Promise.race([run(tick), stalled]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

/** HEAD the file for its byte length — sizes the combined download progress bar.
 *  Best-effort: 0 if the CDN omits it (the bar then falls back to indeterminate) —
 *  never blocks the load. */
async function contentLength(url: string): Promise<number> {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return r.ok ? Number(r.headers.get('content-length')) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Stream the public weight files into OPFS using createSyncAccessHandle inside a
 *  dedicated worker — the in-place, swap-file-free write wllama itself uses, and the
 *  ONLY OPFS write that fits ~1.37 GB on the user's managed machine. A main-thread
 *  createWritable() stages through a `.crswap` swap file that roughly doubles the
 *  transient quota draw and QuotaExceededError's even on a freshly-wiped OPFS whose
 *  reported quota (~3 GB) far exceeds the model. After the worker writes and closes its
 *  handles, the files are read back HERE (main thread) as OPFS-backed Files for wllama's
 *  loadModel — the prototype's proven read path. `onChunk` streams the combined byte
 *  progress (feeds the stall watchdog + the UI bar). Privacy: the worker's only traffic
 *  is the inbound no-store GET of the public weights; no document bytes are involved. */
async function downloadModelsViaWorker(
  dirName: string,
  files: ModelFileSpec[],
  onChunk: (deltaBytes: number) => void,
): Promise<File[]> {
  type Msg = { type: 'progress'; delta: number } | { type: 'done' } | { type: 'error'; message: string };
  const worker = new Worker(new URL('../workers/vlm-download.worker.ts', import.meta.url), { type: 'module', name: 'vlm-download' });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<Msg>): void => {
        const msg = e.data;
        if (msg.type === 'progress') onChunk(msg.delta);
        else if (msg.type === 'done') resolve();
        else reject(modelDownloadError(`OPFS write failed — ${msg.message}`));
      };
      worker.onerror = (e): void => reject(modelDownloadError(`download worker crashed: ${e.message || 'unknown error'}`));
      worker.postMessage({ type: 'download', dirName, files });
    });
  } finally {
    worker.terminate();
  }
  // The worker has closed its sync-access handles, so the files are unlocked and readable
  // here as OPFS-backed Files (wllama reads byte ranges from them on demand via slice()).
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(dirName);
  const out: File[] = [];
  for (const f of files) out.push(await (await dir.getFileHandle(f.name)).getFile());
  return out;
}

/** Reopen a prior OPFS download when every file is present at its expected byte size —
 *  lets a revisit skip re-streaming 1.43 GB. Returns null (→ fresh download) if any file is
 *  missing, unsized, or size-mismatched. */
async function openExistingModels(dirName: string, specs: ModelFileSpec[]): Promise<File[] | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(dirName);
    const out: File[] = [];
    for (const s of specs) {
      const f = await (await dir.getFileHandle(s.name)).getFile();
      if (!(s.expectedSize > 0 && f.size === s.expectedSize)) return null;
      out.push(f);
    }
    return out;
  } catch {
    return null;
  }
}

/** True if the ASCII `needle` appears in `hay`. */
function bytesIncludes(hay: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i <= hay.length - n.length; i++) {
    for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/** Guard the weights before handing them to wllama. A size mismatch means a truncated
 *  download — fail loud, not as a cryptic native `success:false`. Under ?debug=1, log each
 *  file's GGUF magic and whether it carries the `clip` signature wllama's isMmproj() looks
 *  for: that's the difference between "our bytes are wrong" and "the load path is wrong"
 *  (wllama treats a file it can't recognise as an mmproj as a model SHARD, which then fails
 *  to load with every field zeroed). */
async function verifyModelBlobs(blobs: File[], specs: ModelFileSpec[]): Promise<void> {
  // Diagnostics FIRST (both files), so the signatures always print even if a size check
  // below throws. magic should be "GGUF" for both; clip(mmproj)? should be true for the
  // mmproj file and false for the model — that's exactly what wllama's isMmproj() decides on.
  if (isDebug()) {
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i]!;
      const s = specs[i]!;
      const magic = String.fromCharCode(...new Uint8Array(await b.slice(0, 4).arrayBuffer()));
      const meta = new Uint8Array(await b.slice(0, 128 * 1024).arrayBuffer());
      log.debug(`[G] blob ${s.name}: size ${b.size} (exp ${s.expectedSize}) · magic ${JSON.stringify(magic)} · clip(mmproj)? ${bytesIncludes(meta, 'clip')}`);
    }
  }
  for (let i = 0; i < blobs.length; i++) {
    const b = blobs[i]!;
    const s = specs[i]!;
    if (s.expectedSize > 0 && b.size !== s.expectedSize) {
      throw modelDownloadError(`incomplete download: ${s.name} is ${b.size} B, expected ${s.expectedSize} B — clear site data and retry`);
    }
  }
}

// .entries()/.keys() are in the File System Access spec but missing from this TS lib's
// handle types; narrow casts below reach them.
type AsyncDir = { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };

/** Recursive byte size of an OPFS directory — diagnostics only (logs the breakdown of
 *  what's eating the quota under ?debug=1). */
async function dirSizeBytes(handle: FileSystemDirectoryHandle): Promise<number> {
  let total = 0;
  for await (const [, e] of (handle as unknown as AsyncDir).entries()) {
    total += e.kind === 'file' ? (await (e as FileSystemFileHandle).getFile()).size : await dirSizeBytes(e as FileSystemDirectoryHandle);
  }
  return total;
}

/** Wipe OPFS to a pristine slate before a FRESH download of the ~1.4 GB model — only
 *  reached on a cache miss (openExistingModels found no size-matched copy). Clears any
 *  residue from a prior load (an old wllama download cache, orphaned `.crswap` swap files,
 *  partials) so it can't collide with the new write. User data lives in IndexedDB
 *  (src/orchestrate/db.ts), NOT OPFS — the only OPFS writers are wllama and us — so a full
 *  wipe is safe. Logs each entry's size under ?debug=1 so any residual consumer is visible. */
async function reclaimOpfs(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  for await (const [name, handle] of (root as unknown as AsyncDir).entries()) {
    const mb =
      handle.kind === 'file'
        ? Math.round((await (handle as FileSystemFileHandle).getFile()).size / 1e6)
        : Math.round((await dirSizeBytes(handle as FileSystemDirectoryHandle).catch(() => 0)) / 1e6);
    log.debug(`[G] OPFS entry: ${name} (${handle.kind}) ${mb} MB — removing`);
    await root.removeEntry(name, { recursive: true }).catch((e) => log.debug(`[G] remove ${name} failed:`, e));
  }
  const dir = await root.getDirectoryHandle(VLM_DIR, { create: true });
  const est = await navigator.storage.estimate().catch(() => null);
  if (est) log.debug(`[G] OPFS wiped · usage ${Math.round((est.usage ?? 0) / 1e6)} / quota ${Math.round((est.quota ?? 0) / 1e6)} MB`);
  return dir;
}

/** Best-effort upgrade to persistent storage, then log the quota. persist() asks the browser
 *  to make this origin's storage durable and non-evictable, so the cached ~1.4 GB model
 *  survives storage pressure instead of being silently evicted. Logging the quota also makes a
 *  constrained context obvious in a bug report (e.g. an incognito window, whose small,
 *  fluctuating OPFS quota was what tripped the early QuotaExceededErrors). Never blocks the load. */
async function ensurePersistentStorage(): Promise<void> {
  try {
    const persisted = await navigator.storage.persist?.();
    const est = await navigator.storage.estimate();
    log.debug(`[G] storage.persist() → ${persisted} · usage ${Math.round((est.usage ?? 0) / 1e6)} / quota ${Math.round((est.quota ?? 0) / 1e6)} MB`);
  } catch {
    /* persist/estimate unavailable */
  }
}

export async function loadG(p: GProgress, vlmEp: AppEp = 'webgpu'): Promise<void> {
  if (wllama && loadedVlmEp === vlmEp) return;
  vlmLoadWarning = null;
  if (wllama) await unloadG(); // EP change: reload (n_gpu_layers/mmproj are load-time)
  p.onStatus('importing patched wllama runtime…');
  // Non-literal specifier: the memory-cap-patched copy generated by
  // the eval harness (via npm run app), resolved at runtime.
  const patchedUrl = WLLAMA_INDEX_URL;
  wllamaModule ??= (await import(/* @vite-ignore */ patchedUrl)) as WllamaModule;
  const mod = wllamaModule;
  // Adaptive multi-thread. Deep Read runs on the MAIN thread (see deep-client.ts),
  // where wllama's nested Emscripten pthread pool initializes fine (the prototype ran
  // it multi-threaded) — the silent pool-init deadlock only happened when wllama itself
  // ran inside a Web Worker. Threads speed up the CPU-side work and the wasm fallback;
  // capped at 8, leaving headroom for the UI + GPU driver.
  const threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
  const construct = () =>
    new mod.Wllama({ default: WLLAMA_WASM_URL }, { suppressNativeLog: true, logger: wlLogger });
  const loadOpts = (gpu: boolean) => ({
    n_ctx: 8192,
    n_threads: threads,
    n_batch: 2048,
    // webgpu offloads the decoder (-ngl 99) AND the mtmd vision encoder. The
    // vision-encode offload is the P15 speedup lever (tables-only ~2.4×,
    // byte-exact); wllama 3.5.0 (llama.cpp b9640) runs it without the #234 crash.
    n_gpu_layers: gpu ? 99 : 0,
    flash_attn: false, // GLM-OCR requires flash-attn off (llama.cpp #19721)
    jinja: true, // GGUF's embedded chat template, like native --jinja
    mmproj_offload: gpu, // vision encoder on GPU when webgpu (else CPU)
  });

  // Stream the weights OURSELVES into OPFS (cache:'no-store') and load the OPFS-backed
  // Files. THREE machine-specific failures forced this shape: (1) wllama's loadModelFromUrl
  // lets the cacheable cross-origin response sit in the HTTP cache — a 2nd ~1.4 GB copy
  // against the one per-origin quota (QuotaExceededError); (2) an in-RAM Blob (loadModel)
  // gets spilled to a temp file this disk can't read back (NotReadableError); (3) a
  // main-thread createWritable() OPFS write QuotaExceededError's even on a freshly-wiped
  // OPFS, because its `.crswap` swap file roughly doubles the transient quota draw. The fix
  // mirrors wllama's own loader: write ONE no-store copy into OPFS via createSyncAccessHandle
  // in a worker (in place, no swap), then read it back here and load it. The same OPFS Files
  // feed the webgpu→wasm retry — no second download.
  p.onStatus('downloading GLM-OCR Q8_0 (1.43 GB)…');
  await ensurePersistentStorage(); // may lift a capped best-effort OPFS quota; logs the result
  const [modelTotal, mmprojTotal] = await Promise.all([contentLength(MODEL_URL), contentLength(MMPROJ_URL)]);
  const grandTotal = modelTotal + mmprojTotal;
  const specs: ModelFileSpec[] = [
    { name: 'GLM-OCR-Q8_0.gguf', url: MODEL_URL, expectedSize: modelTotal },
    { name: 'mmproj-GLM-OCR-Q8_0.gguf', url: MMPROJ_URL, expectedSize: mmprojTotal },
  ];
  // Reuse a size-matched prior OPFS copy if present (a revisit then skips re-streaming
  // 1.43 GB); otherwise wipe OPFS — clears any `.crswap` junk from the old createWritable
  // path; user data lives in IndexedDB, not OPFS, so a full wipe is safe — and stream fresh
  // into OPFS via the worker (createSyncAccessHandle, in place).
  let blobs = await openExistingModels(VLM_DIR, specs);
  if (blobs) {
    log.debug('[G] reusing size-matched OPFS model copy — no re-download');
    p.onLoadProgress?.(grandTotal, grandTotal);
  } else {
    await reclaimOpfs();
    blobs = await withStallWatchdog(`GLM-OCR download (${threads}t)`, LOAD_STALL_MS, async (tick) => {
      let loaded = 0;
      const onChunk = (delta: number): void => {
        loaded += delta;
        tick(); // feed the stall watchdog — real download bytes are arriving
        p.onLoadProgress?.(loaded, grandTotal);
      };
      return downloadModelsViaWorker(VLM_DIR, specs, onChunk);
    });
  }
  // Fail loud on a truncated download, and (under ?debug=1) report each file's GGUF magic +
  // mmproj signature — so a native "load failed (success:false)" is traceable to the bytes.
  await verifyModelBlobs(blobs, specs);

  let w = construct();
  let useGpu = vlmEp === 'webgpu' && w.isSupportWebGPU();
  vlmEpFallback = vlmEp === 'webgpu' && !useGpu; // requested webgpu but unsupported
  // Preflight the resident footprint against the device's RAM (prefer webgpu —
  // ~1.8 GB vs the wasm path's ~4 GB) and warn loudly if the device looks tight.
  vlmLoadWarning = preflightDeviceMemory(useGpu);
  if (vlmLoadWarning) p.onStatus(vlmLoadWarning);
  p.onStatus(`loading GLM-OCR Q8_0 on ${useGpu ? 'webgpu' : 'wasm'} (${threads} threads)…`);
  // No stall watchdog around loadModel: there's no progress signal to tick it, and
  // wllama's pthread pool inits fine on the main thread (the prototype loads the same
  // way) — the silent pool-init deadlock the watchdog guarded against only happened
  // inside a Web Worker. The download above (where bytes tick continuously) keeps it.
  try {
    await w.loadModel(blobs, loadOpts(useGpu));
  } catch (err) {
    await w.exit().catch(() => {});
    if (!useGpu) {
      // wasm path failed — most often OOM on the ~4 GB vision buffer (a true
      // tab-killing OOM can't be caught here; preferring webgpu + the preflight
      // advisory keep most devices off this path). Surface an actionable message.
      const detail = String((err as Error)?.message ?? err).slice(0, 160);
      throw modelDownloadError(
        `Couldn't load the OCR model — your device may be low on memory (the CPU path needs ~4 GB free). ` +
          `Close other tabs, use a desktop Chrome/Edge with WebGPU, or try a smaller image. (${detail})`,
      );
    }
    // webgpu load failed (driver / wllama #234) — retry on the CPU/wasm backend, which
    // has the broadest compatibility, reusing the already-downloaded blobs.
    log.warn('[G] webgpu VLM load failed — falling back to wasm', err);
    vlmEpFallback = true;
    useGpu = false;
    w = construct();
    p.onStatus('webgpu unavailable — loading GLM-OCR on wasm…');
    await w.loadModel(blobs, loadOpts(false));
  }
  if (!w.supportInputModality('image')) {
    await w.exit();
    throw new Error('model loaded but image input modality unsupported (mmproj missing?)');
  }
  wllama = w;
  loadedThreads = w.getNumThreads();
  loadedVlmEp = useGpu ? 'webgpu' : 'wasm';
}

export async function unloadG(): Promise<void> {
  if (wllama) {
    await wllama.exit();
    wllama = null;
    loadedThreads = 0;
    loadedVlmEp = null;
    vlmLoadWarning = null;
  }
}

/** Free the active document's working set (deterministic-stage crops + decode
 *  outputs) WITHOUT unloading the resident model/engines. The app calls this at
 *  the end of a sequential batch so the last document's buffers don't linger;
 *  mid-batch, each new document already evicts the previous via bindActiveDoc. */
export function releaseG(): void {
  livePageCache.clear();
  decodeCache.clear();
  activeDocUrl = null;
}

/** Adapted from the eval harness VLM probe decodeRegion: identical greedy
 *  request (byte-matching the bake-off llama-server semantics); adds streaming
 *  + cancel hooks and caches clean decodes in memory. */
async function decodeRegion(
  page: ExportPage,
  index: number,
  crops: Map<number, ArrayBuffer>,
  p: GProgress,
  cancel?: AbortSignal,
): Promise<{ rec: VlmRegionOut; cached: boolean }> {
  const reg = page.regions[index]!;
  const rec: VlmRegionOut = {
    index: reg.index,
    regionKey: reg.regionKey,
    ms: 0,
    tokensOut: 0,
    outputMd: null,
    truncated: false,
    repetition: false,
    timedOut: false,
    error: null,
  };
  if (reg.skipped) {
    rec.error = `skipped:${reg.skipped}`;
    return { rec, cached: false };
  }
  const png = crops.get(reg.index);
  if (!png) {
    rec.error = 'no live crop for region';
    return { rec, cached: false };
  }
  const cacheKey = `${reg.regionKey}-${(await sha256hex(png)).slice(0, 8)}`;
  const hit = decodeCache.get(cacheKey);
  if (hit) return { rec: hit, cached: true };
  try {
    const prepped = prepCropPolicy(await decodePng(png));
    const sendBytes = prepped.modified ? await encodePng(prepped.img) : png;

    const task = taskOf(reg.label);
    const area = Math.max(1, (reg.box.x1 - reg.box.x0) * (reg.box.y1 - reg.box.y0));
    const budget = tokenBudget(reg.kind, task, reg.lines.length, area, null);
    const prompt = promptFor(cfg, reg.label);

    let text = '';
    let finish: string | null = null;
    let timings: ChatCompletionChunk['timings'] | undefined;
    const ac = new AbortController();
    const onCancel = () => ac.abort();
    cancel?.addEventListener('abort', onCancel, { once: true });
    const t0 = performance.now();
    const deadline = setTimeout(() => ac.abort(), MAX_TIME_S * 1000);
    try {
      await wllama!.createChatCompletion({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', data: sendBytes },
              { type: 'text', text: prompt },
            ],
          },
        ],
        // Greedy, byte-matching the native llama-server request body.
        temperature: 0,
        top_k: 1,
        seed: 0,
        max_tokens: budget,
        cache_prompt: false,
        timings_per_token: true,
        abortSignal: ac.signal,
        stream: true,
        onData: (chunk) => {
          const c = chunk.choices?.[0];
          const delta = c?.delta?.content;
          if (delta) {
            text += delta;
            p.onToken?.(text);
          }
          if (c?.finish_reason) finish = c.finish_reason;
          if (chunk.timings) timings = chunk.timings;
        },
      });
    } catch (err) {
      if (!ac.signal.aborted) throw err;
      if (cancel?.aborted) throw new CancelledError(); // user cancel — propagate
      rec.timedOut = true; // deadline abort — keep partial text
    } finally {
      clearTimeout(deadline);
      cancel?.removeEventListener('abort', onCancel);
    }
    const ms = performance.now() - t0;
    rec.ms = Math.round(ms * 10) / 10;
    rec.tokensOut = timings?.predicted_n ?? Math.max(1, Math.floor(text.length / 4));
    rec.truncated = finish === 'length';
    rec.timedOut = rec.timedOut || ms >= MAX_TIME_S * 1000;
    const tr = truncateRepeats(text.trim());
    rec.outputMd = tr.text;
    rec.repetition = tr.repetition;
    // A silently-empty decode is a broken engine call, never a valid read.
    if (rec.outputMd === '' && !rec.timedOut) {
      rec.error = 'empty-output';
      rec.outputMd = null;
    }
    if (!rec.error && !rec.timedOut) decodeCache.set(cacheKey, rec);
  } catch (err) {
    if (err instanceof CancelledError) throw err;
    rec.error = String((err as Error)?.message ?? err).slice(0, 300);
  }
  return { rec, cached: false };
}

export async function runG(
  tag: string,
  imageUrl: string,
  gmode: GMode,
  p: GProgress,
  cancel?: AbortSignal,
  onnxEp: AppEp = 'webgpu',
  vlmEp: AppEp = 'webgpu',
): Promise<GRunResult> {
  const tWall = performance.now();
  bindActiveDoc(imageUrl); // a new document evicts the previous one's caches first
  await loadG(p, vlmEp);
  const { page, crops } = await buildLivePage(tag, imageUrl, (s) => p.onStatus(s), onnxEp);

  // Region order mirrors the eval harness VLM probe vlmRunPage.
  let order = page.regions.map((_, i) => i);
  if (gmode === 'tables-only') order = order.filter((i) => page.regions[i]!.kind === 'table');

  const vlmByKey = new Map<string, VlmRegionOut>();
  let decoded = 0;
  let cachedCount = 0;
  for (const [k, i] of order.entries()) {
    if (cancel?.aborted) throw new CancelledError();
    const reg = page.regions[i]!;
    p.onRegionStart?.(k + 1, order.length, reg.kind);
    const { rec, cached } = await decodeRegion(page, i, crops, p, cancel);
    vlmByKey.set(rec.regionKey, rec);
    if (cached) cachedCount++;
    else if (!rec.error) decoded++;
    p.onRegionEnd?.(k + 1, order.length, rec, cached);
  }

  p.onStatus('assembling + anchoring (replace)…');
  const tS = performance.now();
  const { doc, stats, vlmMsUsed, uncertainty, verification } = await buildDocFromReplay(page, vlmByKey, { gmode, anchor: 'replace' });
  const markdown = renderMarkdown(doc);
  const structureMs = performance.now() - tS;

  // Note format mirrors the eval harness replay G adapter runPage.
  const a = stats.anchor;
  const note =
    `vlm live (glm-ocr-q8/${cfg.promptRev}@${loadedVlmEp}-${loadedThreads}t); ` +
    `regions ${stats.vlmUsed} vlm / ${stats.gridRouted} grid / ${stats.tableFallback} tbl-fb / ${stats.ocrFallback} ocr-fb; ` +
    `anchor[replace] ${a.exact + a.splitJoined}/${a.total} ok, ${a.replaced.length} repl, ${a.dropped.length} drop, ${a.flagged.length} flag` +
    (a.ambiguous.length ? `, ${a.ambiguous.length} ambig` : '');

  return {
    markdown,
    doc,
    note,
    uncertainty,
    verification,
    stats,
    stageMs: {
      layout: page.stageMs.layout,
      det: page.stageMs.det,
      rec: page.stageMs.rec,
      vlm: Math.round(vlmMsUsed),
      structure: Math.round(structureMs),
    },
    wallMs: Math.round(performance.now() - tWall),
    decoded,
    cachedCount,
    regions: [...vlmByKey.values()],
  };
}
