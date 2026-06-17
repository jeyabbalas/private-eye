/**
 * Typed message protocol between the main thread (UI) and the pipeline Web
 * Workers. Keeping inference off the main thread is what keeps the UI responsive
 * while a page is being read.
 */
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import type { VerificationResult } from '../structure/verify.ts';
import type { Block } from '../structure/blocks.ts';
import type { AppError } from '../runtime/errors.ts';
import type { AppEp } from '../runtime/run-e.ts';

/** Coarse processing stages, mapped to plain-language status on the main thread. */
export type StageKey = 'loading' | 'decoding' | 'analyzing' | 'finishing';

/** The serializable result of reading one page (no pixel buffers cross the wire). */
export interface PageResult {
  markdown: string;
  uncertainty?: UncertaintyLayer;
  verification?: VerificationResult;
  /** The document model the Markdown was rendered from — the review UI renders it
   *  block-by-block and joins each block to its provenance via the block index. */
  blocks?: Block[];
  note?: string;
  stageMs: Record<string, number>;
  totalMs: number;
  width: number;
  height: number;
}

// main -> Quick Read worker
export type ToQuickWorker =
  | { type: 'init'; debug: boolean; onnxEp: AppEp }
  | { type: 'warm' }
  | { type: 'run'; jobId: number; tag: string; imageUrl: string }
  /** On-demand OCR of a user-drawn region (Phase 4). `imageUrl` is a crop of the
   *  page at the region; (originX, originY) is the region's page-pixel origin so
   *  the worker can offset the result back into page space. */
  | { type: 'reocr-region'; jobId: number; imageUrl: string; originX: number; originY: number };

// Quick Read worker -> main
export type FromQuickWorker =
  | { type: 'ready'; epNote: string }
  | { type: 'load-progress'; loaded: number; total: number }
  | { type: 'stage'; jobId: number; stage: StageKey; raw: string }
  | { type: 'result'; jobId: number; result: PageResult }
  /** Region OCR result: assembled blocks already in PAGE coordinates. */
  | { type: 'region-result'; jobId: number; blocks: Block[] }
  | { type: 'error'; jobId: number | null; error: AppError };
