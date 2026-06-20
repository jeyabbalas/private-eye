/**
 * Data model for persisted work (IndexedDB). The guiding rule from the plan:
 * store SOURCES, not derivatives — original PDF/image Blobs + result JSON +
 * corrections. We never persist object URLs (recreated from Blobs on load) and
 * never persist PDF page rasters (re-rasterized on demand from the source PDF,
 * deterministically, via the stored `renderScale`).
 */
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import type { VerificationResult } from '../structure/verify.ts';
import type { Block } from '../structure/blocks.ts';

export type DocId = string;
export type PageId = string;

export type DocKind = 'image' | 'pdf';

/** Which pipeline a page is read with. Quick = the default deterministic read;
 *  Deep = the opt-in AI-assisted read (Pipeline G + safety fallback). Chosen at
 *  enqueue time, not persisted on the page (a reload resumes as Quick — no
 *  surprise 1.4 GB download); the produced ResultRecord records what actually ran. */
export type ReadMode = 'quick' | 'deep';

/**
 * Page processing lifecycle:
 *   queued → rasterizing → processing → (needs-review | done)
 * with error / cancelled as alternative terminal states. `needs-review` and
 * `done` both mean "read successfully"; they differ only in whether the
 * uncertainty / verifier signals asked for a human look.
 */
export type PageStatus =
  | 'queued'
  | 'rasterizing'
  | 'processing'
  | 'needs-review'
  | 'done'
  | 'error'
  | 'cancelled';

export interface DocumentRecord {
  id: DocId;
  /** Original file name (used for display, tags, and export filenames). */
  name: string;
  kind: DocKind;
  mime: string;
  pageCount: number;
  /** Blob-store key of the original uploaded bytes (never an object URL). */
  blobKey: string;
  /** Sort order in the document list (monotonic; new docs append). */
  order: number;
  createdAt: number;
}

export interface PageRecord {
  id: PageId;
  docId: DocId;
  /** 1-based page number within the document. */
  pageNo: number;
  status: PageStatus;
  /**
   * Blob-store key of a persisted raster, if any. Normally null: PDF pages are
   * re-rasterized on demand from the source PDF rather than stored (saves quota
   * and avoids eviction). Kept as an escape hatch.
   */
  rasterKey?: string | null;
  /** PDF render scale actually used — lets us reproduce identical pixels (and
   *  thus pixel-aligned uncertainty boxes) on demand without re-deriving it. */
  renderScale?: number;
  /** Processed raster dimensions in page pixels (the coordinate space of the
   *  uncertainty layer). */
  width?: number;
  height?: number;
  /** Plain-language error message when status === 'error'. */
  error?: string;
  updatedAt: number;
}

/** A successful page read: the serializable PageResult plus identity + which
 *  pipeline produced it. */
export interface ResultRecord {
  pageId: PageId;
  docId: DocId;
  /** E = Quick Read (or Deep Read's deterministic fallback); G = Deep Read. */
  pipeline: 'E' | 'G';
  /** True when a Deep Read read fell back to the exact transcription because its
   *  verification gate tripped — drives the "switched to exact" verdict banner. */
  fellBack?: boolean;
  markdown: string;
  uncertainty?: UncertaintyLayer;
  verification?: VerificationResult;
  /** The document model the Markdown was rendered from (review provenance). */
  blocks?: Block[];
  note?: string;
  totalMs: number;
  stageMs: Record<string, number>;
  width: number;
  height: number;
  createdAt: number;
}

/**
 * User corrections for a page. Phase 2 persists only the saved Markdown override
 * (what export uses). Phase 3 adds the reversible event log it is rendered from;
 * `events`/`baseHash` are reserved for that and opaque to persistence here.
 */
export interface CorrectionRecord {
  pageId: PageId;
  docId: DocId;
  /** The corrected Markdown — overrides ResultRecord.markdown on export. */
  markdown: string;
  /** Reversible correction events (Phase 3). */
  events?: unknown[];
  /** Hash of the base result the edits were made against (staleness guard). */
  baseHash?: string;
  /** Remembered highlight-sensitivity threshold (τ) for this page's review. A pure
   *  view preference (not a correction); restored independent of `baseHash`. */
  tau?: number;
  updatedAt: number;
}

/** Statuses that mean "read successfully" (have a ResultRecord). */
export const PROCESSED: ReadonlySet<PageStatus> = new Set<PageStatus>(['needs-review', 'done']);

/** Statuses that will not change without user action. */
export const TERMINAL: ReadonlySet<PageStatus> = new Set<PageStatus>([
  'needs-review',
  'done',
  'error',
  'cancelled',
]);
