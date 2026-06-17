/**
 * Pipeline E for the manual-test app: the official 'ppstructure' adapter,
 * invoked exactly like the eval harness bench runner runBench — but kept resident
 * across runs so sequential pages reuse the loaded ONNX sessions (the
 * batch-memory behavior the app exists to exercise).
 *
 * EP-aware: the context default EP follows the app's "onnx ep" select with
 * per-model wasm fallback (a webgpu-less browser still completes the run; the
 * fallback is surfaced via eEpNote). Switching EP lazily disposes and reloads
 * on the next run — sessions are EP-bound at creation.
 */
import { createBrowserContext } from '../adapters/browser.ts';
import { createPipeline } from '../pipelines/registry.ts';
import { SLANET_MODEL_SPEC } from '../engines/slanet/index.ts';
import type { InitStats, PageRun, PipelineAdapter } from '../pipelines/types.ts';
import { log } from './logger.ts';

export type AppEp = 'wasm' | 'webgpu';

let ctx = createBrowserContext();
let pipe: PipelineAdapter | null = null;
let initStats: InitStats | null = null;
let loadedEp: AppEp | null = null;
let fallbacks: string[] = [];

export const isELoaded = (): boolean => pipe !== null;

/** "" until a run loaded models; then e.g. "onnx ep: webgpu · slanet: wasm" or
 *  the fallback story. SLANet's wasm pin (see makeCtx) is surfaced so the
 *  per-stage story stays honest — on webgpu the table stage still runs on CPU. */
export const eEpNote = (): string => {
  if (!loadedEp) return '';
  const slanet = loadedEp === 'webgpu' ? ' · slanet: wasm (Loop op, no webgpu kernel)' : '';
  const fb = fallbacks.length ? ` · fallback → wasm: ${fallbacks.join('; ')}` : '';
  return `onnx ep: ${loadedEp}${slanet}${fb}`;
};

function makeCtx(ep: AppEp) {
  fallbacks = [];
  return createBrowserContext({
    ep,
    // SLANet's structure decoder (SLAHead) is a single ONNX `Loop`, and ORT-web
    // 1.26's WebGPU EP (JSEP) has no Loop kernel — so on webgpu the whole decode
    // runs on CPU ANYWAY, plus a GPU↔CPU feature round-trip, making it 1.2–3.6×
    // SLOWER than plain wasm (measured: ho-ihc table 181 ms wasm → 645 ms webgpu).
    // Pin it to wasm so it takes its fastest path; layout/det/rec keep the 7–17×
    // webgpu win. Output-identical (the Loop already ran on CPU): parity ΔCER 0.00.
    // The override only bites when ep=webgpu — a wasm context is all-wasm already.
    epOverrides: { [SLANET_MODEL_SPEC.id]: 'wasm' },
    epFallback: true,
    onEpFallback: (id, requested, err) => {
      fallbacks.push(`${id} (${String((err as Error)?.message ?? err).slice(0, 80)})`);
      log.warn(`[E] ${id}: ${requested} session failed, using wasm`, err);
    },
  });
}

export async function ensureE(onStatus: (s: string) => void, ep: AppEp = 'webgpu'): Promise<InitStats> {
  if (pipe && initStats && loadedEp === ep) return initStats;
  if (pipe) await disposeE();
  onStatus(`loading E models (~155 MB: layout + det + rec + slanet) on ${ep}…`);
  ctx = makeCtx(ep);
  const p = createPipeline('ppstructure'); // defaults: det=mobile, order=learned, table=slanet
  initStats = await p.init(ctx);
  pipe = p;
  loadedEp = ep;
  return initStats;
}

export async function runE(imageUrl: string, onStatus: (s: string) => void, ep: AppEp = 'webgpu'): Promise<PageRun> {
  await ensureE(onStatus, ep);
  onStatus('decoding image…');
  const image = await ctx.decodeImage(imageUrl);
  // runPage is monolithic (no intra-page hooks); the caller's elapsed ticker
  // is the liveness signal, the stage breakdown arrives with the result.
  onStatus(`layout + OCR + tables (${loadedEp})…`);
  return pipe!.runPage({ image, source: imageUrl }, ctx);
}

export async function disposeE(): Promise<void> {
  if (pipe) {
    await pipe.dispose();
    pipe = null;
    initStats = null;
    loadedEp = null;
  }
}
