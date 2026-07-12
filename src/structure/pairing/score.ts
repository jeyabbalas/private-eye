/**
 * Candidate-interpretation scoring — gate cascades become score components.
 *
 * Every interpretation of a region (stacked kv under several bandings, inline
 * kv, table, plain lines) gets a score on [0,1]; the argmax wins. `lines`
 * scores a fixed neutral value, so a structural reading must positively BEAT
 * "these are just lines" — the old failure mode (paragraph soup returned as a
 * successful grid) is unrepresentable.
 *
 * All penalties are graded multipliers absorbing the old binary gates
 * (hasAlignedColumns): a marginal geometry now DISCOUNTS a score (and later
 * the pair confidence) instead of flipping the outcome at an arbitrary edge.
 */
import type { Banding, GapSplit } from './cluster.ts';
import { sigma, type PairingWeights } from './weights.ts';

export interface GridStats {
  /** Non-empty cells in the snapped grid. */
  totalCells: number;
  /** Cells that swallowed >1 segment (nearest-snap collisions). */
  collidedCells: number;
  /** median(first-cell widths) / page width — wide first cells mean wrapped
   *  body text with a split-off fragment, not a label column. */
  firstCellWidthShare: number;
  /** (max col anchor − min col anchor) / page width. */
  colSpanShare: number;
  /** Rows with ≥ 2 cells. */
  multiCellRows: number;
  nRows: number;
  nCols: number;
}

/** Graded region-plausibility discounts (formerly hasAlignedColumns' gates:
 *  ≥2 multi-cell rows; span ≥ 12% of width; narrow first cells ≤ 30%). The
 *  0.3/0.12 width ratios are the pre-existing dimensionless constants. */
export function gridPenalties(s: GridStats): number {
  let p = 1;
  if (s.totalCells > 0) p *= 1 - 0.5 * (s.collidedCells / s.totalCells);
  if (s.firstCellWidthShare > 0.3) p *= Math.max(0.4, 1 - 2 * (s.firstCellWidthShare - 0.3));
  if (s.colSpanShare < 0.12) p *= Math.max(0.2, s.colSpanShare / 0.12);
  p *= s.multiCellRows >= 2 ? 1 : s.multiCellRows === 1 ? 0.6 : 0.3;
  return p;
}

/** Gap-evidence agreement of a banding: over every row boundary, does the
 *  banding's cut/no-cut match the gap cluster's big/small verdict? No valid
 *  gap split → 0.5 (geometry is uninformative, content must carry it). When
 *  banding and gap evidence coincide exactly this reaches 1 and multiplies
 *  with a high alternation — the "noisy-OR" agreement bonus. */
export function geomScore(banding: Banding, gapSplit: GapSplit | null, nRows: number): number {
  if (!gapSplit || nRows < 2) return 0.5;
  const cuts = new Set<number>();
  let row = 0;
  for (const band of banding.bands.slice(0, -1)) {
    row += band.length;
    cuts.add(row); // a band starts at row index `row` → boundary (row-1 → row)
  }
  let agree = 0;
  for (let i = 1; i < nRows; i++) {
    const shouldCut = gapSplit.bigIdx.has(i - 1);
    if (cuts.has(i) === shouldCut) agree++;
  }
  return agree / (nRows - 1);
}

export interface StackedInputs {
  /** σ(label-row vote)·σ(−value-rows vote) per ≥2-row band. */
  bandScores: number[];
  banding: Banding;
  gapSplit: GapSplit | null;
  nRows: number;
  /** Cells participating in emitted pairs / total cells. */
  completeness: number;
  penalties: number;
}

export function stackedScore(inp: StackedInputs, w: PairingWeights): number {
  const alternation = inp.bandScores.length ? inp.bandScores.reduce((a, b) => a + b, 0) / inp.bandScores.length : 0;
  const geom = geomScore(inp.banding, inp.gapSplit, inp.nRows);
  const mix = w.stacked.alternation * alternation + w.stacked.geom * geom + w.stacked.completeness * inp.completeness;
  return mix * inp.penalties;
}

export interface InlineInputs {
  /** σ(label-col vote)·σ(−value-col vote) per mutual column pair. */
  pairTypeScores: number[];
  /** Mutual-nearest assignments / label cells in paired columns. */
  mutuality: number;
  completeness: number;
  penalties: number;
}

export function inlineScore(inp: InlineInputs, w: PairingWeights): number {
  if (!inp.pairTypeScores.length) return 0;
  const ptq = inp.pairTypeScores.reduce((a, b) => a + b, 0) / inp.pairTypeScores.length;
  const mix = w.inline.pairType * ptq + w.inline.mutuality * inp.mutuality + w.inline.completeness * inp.completeness;
  return mix * inp.penalties;
}

export interface TableInputs {
  /** σ(first-row vote) — data tables open with a label-typed header row. */
  headerScore: number;
  /** Sign-alignment of per-column body votes: consistent columns (marker
   *  column, result column) ≈ 1; label/value ALTERNATION down a column ≈ 0 —
   *  this is what lets a kv grid beat the table reading while a genuine
   *  marker table keeps it. */
  columnHomogeneity: number;
  /** Fill share × row-count saturation. */
  shape: number;
  penalties: number;
  /** The layout model called this region a table. */
  tablePrior: boolean;
}

export function tableScore(inp: TableInputs, w: PairingWeights): number {
  const mix = w.table.header * inp.headerScore + w.table.homogeneity * inp.columnHomogeneity + w.table.shape * inp.shape;
  return mix * inp.penalties + (inp.tablePrior ? w.table.prior : 0);
}

/** Sign-alignment homogeneity of one column's body votes (|Σwv| / Σw|v|). */
export function signAlignment(votes: { v: number; strong: boolean }[]): number {
  const typed = votes.filter((c) => Math.abs(c.v) >= 0.05);
  if (typed.length < 2) return 0.5;
  let num = 0;
  let den = 0;
  for (const c of typed) {
    const w = c.strong ? 1 : 0.5;
    num += w * c.v;
    den += w * Math.abs(c.v);
  }
  return den > 0 ? Math.abs(num) / den : 0.5;
}

/**
 * Pair confidence = geometric mean of three [0,1] factors: how label/value-
 * typed the two sides are (context-blended), how separated the winning
 * assignment was from its runner-up, and how decisively this interpretation
 * beat the alternatives. Every former binary gate is a discount here. Floored
 * at 0.01: an emitted pair is a claim, and claims are never exactly zero.
 */
export function pairConfidence(typePlausibility: number, assignMarginMapped: number, interpMarginMapped: number): number {
  const c = Math.cbrt(Math.max(0, typePlausibility) * Math.max(0, assignMarginMapped) * Math.max(0, interpMarginMapped));
  return Math.min(1, Math.max(0.01, c));
}

/** sqrt(σ(v_label)·σ(−v_value)) — the shared "does this READ like label→value"
 *  factor, used by pair confidence and by single-line kv acceptance. */
export function typePlausibility(vLabel: number, vValue: number, k: number): number {
  return Math.sqrt(sigma(vLabel, k) * sigma(-vValue, k));
}
