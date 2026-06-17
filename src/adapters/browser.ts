/**
 * Browser runtime adapter: Canvas/ImageBitmap decode, fetch for assets/models,
 * onnxruntime-web (WASM or WebGPU EP) for inference. The production deployment
 * target — proves the pipeline code (which only ever touches RuntimeContext)
 * runs unchanged client-side. No data leaves the page: every fetch is to the
 * same origin (models + fixtures), inference is local WASM/WebGPU.
 */
import * as ort from 'onnxruntime-web';
import type { InferenceSession } from 'onnxruntime-common';
import type { RasterImage } from '../core/types.ts';
import type { ExecutionProvider, ImageSource, ModelSpec, OrtSessionOpts, RuntimeContext } from './types.ts';
import { modelUrl, ORT_WASM_DIR } from '../runtime/assets.ts';

// onnxruntime-web WASM runtime files are vendored same-origin (public/ort/).
// Quick Read runs primarily on WebGPU; the WASM fallback stays single-threaded
// for maximum compatibility (threading is a later optimization).
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = ORT_WASM_DIR;
ort.env.webgpu.powerPreference = 'high-performance';

export interface BrowserContextOpts {
  /** Default EP for every session created on this context (per-call opts.ep wins). */
  ep?: ExecutionProvider;
  /** Per-model override by ModelSpec.id; wins over `ep`, loses to per-call opts.ep. */
  epOverrides?: Record<string, ExecutionProvider>;
  /** webgpu session-creation failure → retry once on wasm and report (app mode).
   *  Default false = strict: failures propagate (bench / probes / parity). */
  epFallback?: boolean;
  onEpFallback?: (specId: string, requested: ExecutionProvider, err: unknown) => void;
}

async function decodeImage(src: ImageSource): Promise<RasterImage> {
  const blob = await (await fetch(src)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const cx = canvas.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(bmp, 0, 0);
  const img = cx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { data: img.data, width: img.width, height: img.height };
}

async function readBytes(src: ImageSource): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(src)).arrayBuffer());
}

async function assetSize(rel: string): Promise<number> {
  const head = await fetch(modelUrl(rel), { method: 'HEAD' });
  const len = head.headers.get('content-length');
  if (len) return Number(len);
  return (await readBytes(modelUrl(rel))).byteLength;
}

async function fetchModel(spec: ModelSpec): Promise<{ data: Uint8Array; bytes: number }> {
  const data = await readBytes(modelUrl(spec.url));
  let bytes = data.byteLength;
  for (const ext of spec.externalData ?? []) bytes += (await readBytes(modelUrl(ext))).byteLength;
  return { data, bytes };
}

export function createBrowserContext(ctxOpts: BrowserContextOpts = {}): RuntimeContext {
  async function createSession(spec: ModelSpec, opts: OrtSessionOpts = {}): Promise<InferenceSession> {
    // Per-call > per-model override > context default > wasm. Engines never
    // pass opts.ep, so pipelines follow the context (probes stay explicit).
    const resolved = opts.ep ?? ctxOpts.epOverrides?.[spec.id] ?? ctxOpts.ep ?? 'wasm';
    const { data } = await fetchModel(spec);
    // External-data models (none in pipeline B) would register buffers here.
    const externalData = await Promise.all(
      (spec.externalData ?? []).map(async (ext) => ({ path: ext.split('/').pop()!, data: await readBytes(modelUrl(ext)) })),
    );
    const create = (ep: ExecutionProvider) =>
      ort.InferenceSession.create(data, {
        executionProviders: ep === 'webgpu' ? ['webgpu'] : ['wasm'],
        graphOptimizationLevel: 'all',
        ...(externalData.length ? { externalData } : {}),
      });
    if (resolved !== 'webgpu' || !ctxOpts.epFallback) return create(resolved);
    try {
      return await create('webgpu');
    } catch (err) {
      ctxOpts.onEpFallback?.(spec.id, 'webgpu', err);
      return create('wasm');
    }
  }

  return {
    kind: 'browser',
    decodeImage,
    readBytes,
    fetchModel,
    createSession,
    assetUrl: (rel) => modelUrl(rel),
    assetSize,
    now: () => performance.now(),
  };
}
