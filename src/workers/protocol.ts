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

// ---------------------------------------------------------------------------
// Deep Read (Pipeline G + router) worker
// ---------------------------------------------------------------------------

/** Coarse Deep Read phases. The runner's raw status strings carry jargon
 *  ("layout", "anchoring", "Pipeline E"), so the worker maps them to this enum
 *  and the main thread renders plain detective copy from it. `cross-examining`
 *  carries the per-region counts for "region i of n". */
export type DeepPhaseKind =
  | 'preparing'
  | 'examining'
  | 'cross-examining'
  | 'verifying'
  | 'fallback'
  | 'finishing';

/** A Deep Read result: a PageResult plus which pipeline actually produced it and
 *  whether the safety gate fell back to the exact transcription. */
export interface DeepResult extends PageResult {
  /** E = the deterministic fallback fired; G = the AI-assisted read was kept. */
  pipeline: 'E' | 'G';
  /** True when Deep Read's verification gate tripped and E was substituted. */
  fellBack: boolean;
}

// main -> Deep Read worker
export type ToDeepWorker =
  | { type: 'init'; debug: boolean; onnxEp: AppEp; vlmEp: AppEp }
  /** Download + load the VLM (the ~1.4 GB one-time fetch; cached in OPFS after). */
  | { type: 'load'; jobId: number }
  | { type: 'run'; jobId: number; tag: string; imageUrl: string }
  /** Abort the in-flight decode. Handled OUT OF BAND (not via the serial chain),
   *  so it interrupts a running job rather than queueing behind it. */
  | { type: 'cancel'; jobId: number };

// Deep Read worker -> main
export type FromDeepWorker =
  | { type: 'loaded'; jobId: number; epNote: string }
  | { type: 'load-progress'; loaded: number; total: number }
  | { type: 'phase'; jobId: number; phase: DeepPhaseKind; index?: number; total?: number }
  | { type: 'result'; jobId: number; result: DeepResult }
  /** The user cancelled; the in-flight decode was aborted cleanly. */
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number | null; error: AppError };
