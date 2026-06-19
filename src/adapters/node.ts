/**
 * Node runtime adapter: the headless counterpart to src/adapters/browser.ts, used
 * by the verification harness (scripts/ocr-harness.ts) to run the OCR engine
 * against fixtures on disk. Mirrors the browser adapter's RuntimeContext contract
 * but resolves models/-relative asset paths to local files (populated by
 * `npm run fetch-models`) and decodes images via @napi-rs/canvas instead of the
 * DOM. Inference uses onnxruntime-web's Node (WASM) build — the same kernels as
 * the browser WASM EP, so harness numbers track the production WASM path.
 *
 * Node/test-only: never imported by the browser app, so it is never bundled by
 * Vite (only scripts/ import it).
 */
import * as ort from 'onnxruntime-web';
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { InferenceSession } from 'onnxruntime-common';
import type { RasterImage } from '../core/types.ts';
import type { ImageSource, ModelSpec, OrtSessionOpts, RuntimeContext } from './types.ts';

// Single-threaded WASM for portability/determinism (matches the browser fallback).
// The onnxruntime-web Node build bundles its own wasm, so wasmPaths is normally
// unnecessary; if session creation ever fails with "no available backend" /
// "failed to load wasm", set:
//   ort.env.wasm.wasmPaths = join(REPO_ROOT, 'node_modules/onnxruntime-web/dist/');
ort.env.wasm.numThreads = 1;

const REPO_ROOT = join(import.meta.dirname, '..', '..');

export interface NodeContextOpts {
  /** Root directory for models/-relative assets (default <repo>/models). */
  modelsDir?: string;
}

/** A RuntimeContext backed by the local filesystem + onnxruntime-web (Node WASM). */
export function createNodeContext(opts: NodeContextOpts = {}): RuntimeContext {
  const modelsDir = opts.modelsDir ?? join(REPO_ROOT, 'models');
  /** Resolve a models/-relative asset path to an absolute disk path. */
  const assetAbs = (rel: string): string => join(modelsDir, rel.replace(/^\//, ''));

  async function decodeImage(src: ImageSource): Promise<RasterImage> {
    const img = await loadImage(src);
    const canvas = createCanvas(img.width, img.height);
    const cx = canvas.getContext('2d')!;
    cx.drawImage(img, 0, 0);
    const id = cx.getImageData(0, 0, img.width, img.height);
    return { data: id.data, width: img.width, height: img.height };
  }

  async function readBytes(src: ImageSource): Promise<Uint8Array> {
    return new Uint8Array(await readFile(src));
  }

  async function fetchModel(spec: ModelSpec): Promise<{ data: Uint8Array; bytes: number }> {
    const data = await readBytes(assetAbs(spec.url));
    let bytes = data.byteLength;
    for (const ext of spec.externalData ?? []) bytes += (await readBytes(assetAbs(ext))).byteLength;
    return { data, bytes };
  }

  async function assetSize(rel: string): Promise<number> {
    return (await stat(assetAbs(rel))).size;
  }

  // EP is fixed to wasm on Node (no webgpu); opts.ep is accepted but ignored.
  async function createSession(spec: ModelSpec, _opts: OrtSessionOpts = {}): Promise<InferenceSession> {
    const data = await readBytes(assetAbs(spec.url));
    const externalData = await Promise.all(
      (spec.externalData ?? []).map(async (ext) => ({ path: basename(ext), data: await readBytes(assetAbs(ext)) })),
    );
    return ort.InferenceSession.create(data, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      ...(externalData.length ? { externalData } : {}),
    });
  }

  return {
    kind: 'node',
    decodeImage,
    readBytes,
    fetchModel,
    createSession,
    assetUrl: (rel) => assetAbs(rel),
    assetSize,
    now: () => performance.now(),
  };
}
