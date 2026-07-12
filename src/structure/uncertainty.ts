/**
 * The serializable uncertainty contract that Pipelines E and G attach to
 * `PageRun.uncertainty`, consumed by the human-in-the-loop verification app to
 * focus expert attention on the regions/characters the OCR is least sure about.
 *
 * Statistical intent (see docs plan): the ONLY within-model signal we surface is
 * calibrated PP-OCR character confidence (`lines`); everything else is
 * cross-model agreement — coverage gaps (OCR text outside any layout region) and
 * numeric disagreement (VLM vs OCR, Pipeline G). We deliberately do NOT surface:
 *   - raw PP-DocLayoutV3 region scores (miscalibrated; silent on missed regions),
 *   - SLANet table-structure confidence (argmax over predictable tokens →
 *     meaningless; `tableStructureConfidence` is `null` by design),
 *   - GLM-OCR token logprobs (corrupted by the LM prior → confident hallucinations).
 *
 * `PageRun.uncertainty` is left `undefined` (not an empty layer) when no estimate
 * is available, so "no signal" is distinguishable from "all clear".
 */
import type { BBox } from '../core/types.ts';

/** One recognized character with its (calibrated) confidence and page geometry. */
export interface CharSpan {
  ch: string;
  /** Calibrated P(correct) when `UncertaintyLayer.calibration === 'isotonic'`,
   *  else the raw max-softmax (never present raw values as if calibrated). */
  conf: number;
  /** Page-pixel box, sub-allocated within the word/line box (interpolated, not measured). */
  box: BBox;
}

/** Per-line OCR confidence: aggregates for ranking + per-character spans for highlighting. */
export interface LineUncertainty {
  /** Stable index into the page's OCR line array (provenance key). */
  lineId: number;
  box: BBox;
  text: string;
  /** Length-normalized geometric mean of char confidence (line-level ranking). */
  meanLogProb: number;
  /** Worst character / robust-worst character (triage). */
  min: number;
  p10: number;
  /** Character count contributing. */
  n: number;
  /** Per-character spans; empty when an engine provides no per-char confidence. */
  chars: CharSpan[];
}

export type CoverageGapKind = 'orphan-line' | 'near-threshold-region';

/** A "possible missed region — confirm?" candidate. The robust layout-uncertainty
 *  signal: where detection said nothing but another channel found content. */
export interface CoverageGap {
  kind: CoverageGapKind;
  box: BBox;
  /** OCR lines implicated (orphan cluster); empty for near-threshold regions. */
  lineIds: number[];
  /** Near-threshold region only: the layout label and its raw (sub-threshold) score. */
  label?: string;
  rawScore?: number;
}

/** Ties a rendered block back to its source OCR lines for hover-to-highlight, plus
 *  a block-level triage score (worst contributing character confidence). */
export interface BlockProvenance {
  /** Index into `DocModel.blocks`. */
  blockIndex: number;
  kind: string;
  box: BBox;
  lineIds: number[];
  /** Min char confidence over the block's source lines (lower = needs attention). */
  worst: number;
  /** kv blocks only: confidence that label↔value is the RIGHT association
   *  (structural claim, independent of character confidence). Feeds the
   *  'uncertain-pair' attention category under the same τ slider. */
  pairing?: number;
}

export type ReviewKind = 'replaced' | 'flagged' | 'dropped' | 'ambiguous' | 'split-joined' | 'disagree-text';

/** A cross-model disagreement the expert should review (Pipeline G). For numerics
 *  the pipeline prefills the OCR reading (the independent, no-language-prior
 *  channel) and flags it; both readings are always carried. */
export interface ReviewItem {
  kind: ReviewKind;
  /** Region index (ExportRegion.index); -1 orphan; -999 whole-page decode. */
  regionIndex: number;
  /** Index into `DocModel.blocks`; -1 until stamped at the assemble call site. */
  blockIndex: number;
  /** Block box — coarse highlight fallback when a char span is unavailable. */
  box: BBox;
  /** Which block field the span indexes. */
  field?: 'text' | 'lead' | 'label' | 'value' | 'cell';
  /** Table-cell address when `field === 'cell'`. */
  cell?: { row: number; col: number };
  /** Char span into the post-anchor field text (zero-width for dropped tokens). */
  charStart: number;
  charEnd: number;
  /** OCR's reading (the prefilled/kept value); null when OCR has no single reading. */
  ocrReading: string | null;
  /** What the VLM emitted. */
  vlmReading: string;
  /** high = numeric (safety-critical); low = non-numeric prose disagreement. */
  severity: 'high' | 'low';
}

export interface UncertaintyLayer {
  schema: 'uncertainty/1';
  width: number;
  height: number;
  /** Whether a validated calibration map was applied to `lines[].chars[].conf`. */
  calibration: 'isotonic' | 'identity';
  /** Per-line OCR confidence. Primary signal for E; region-level context for G
   *  (it reflects the OCR reading, which does not align char-by-char to VLM text). */
  lines: LineUncertainty[];
  coverageGaps: CoverageGap[];
  blocks: BlockProvenance[];
  /** Cross-model numeric conflicts (Pipeline G); empty for E. */
  reviewItems: ReviewItem[];
  /** Explicit: SLANet grid confidence is unavailable by design. */
  tableStructureConfidence: null;
}
