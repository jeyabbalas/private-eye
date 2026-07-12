/**
 * The unified region interpreter: enumerate plausible READINGS of a multi-cell
 * region (stacked kv under several bandings, inline kv, table, plain lines),
 * score each (score.ts), and return the argmax with Lowe-style margins.
 *
 * Replaces detectFieldGrid's gate cascade. Design contract (plan §Design):
 *  - within-page relative decisions only (gap jumps, mutual nearest neighbours,
 *    score margins) — no absolute px/lineHeight structure thresholds;
 *  - the degenerate per-row reading is ENUMERATED so it must lose a fair fight
 *    (it always does: zero completeness) instead of silently winning;
 *  - every pair carries a confidence; ambiguity discounts, never gates.
 */
import type { BBox } from '../../core/types.ts';
import { boxCenterX, boxCenterY, unionBox } from '../../core/types.ts';
import type { Block } from '../blocks.ts';
import type { PageMetrics } from '../classify.ts';
import type { Seg } from '../fragments.ts';
import { clusterRows } from '../rows.ts';
import { clusterByGap, median, nearestIndex } from '../util.ts';
import { bandingCandidates, splitGapsByJump, type Banding, type GapSplit } from './cluster.ts';
import { blendContext, cellVote, groupVote, type CellVote } from './features.ts';
import {
  gridPenalties,
  inlineScore,
  pairConfidence,
  signAlignment,
  stackedScore,
  tableScore,
  typePlausibility,
  type GridStats,
} from './score.ts';
import { DEFAULT_WEIGHTS, mapMargin, sigma, type PairingWeights } from './weights.ts';
import type { PageLexicon, PairedKv, RegionInterpretation } from './types.ts';

export interface InterpretOptions {
  /** The layout model called this region a table (adds the table prior). */
  tablePrior?: boolean;
  lexicon?: PageLexicon;
  weights?: PairingWeights;
  /** Debug tap: receives every scored candidate (harness/test dissection). */
  onCandidates?: (candidates: { kind: string; layout?: string; score: number; evidence: number; signature: string }[]) => void;
}

const stripColon = (t: string): string => t.trim().replace(/:$/, '').trim();

/** Join wrapped value fragments per the GT convention: ", " unless the previous
 *  fragment already ends with a connector (printed trailing comma etc.). */
export function joinValueTexts(texts: string[]): string {
  let out = texts[0] ?? '';
  for (let i = 1; i < texts.length; i++) {
    out += /[,;:-]$/.test(out.trimEnd()) ? ' ' : ', ';
    out += texts[i]!;
  }
  return out.replace(/\s+/g, ' ').trim();
}

interface Cell {
  segs: Seg[];
  text: string;
  box: BBox;
  vote: CellVote;
}

interface ColumnCandidate {
  anchors: number[];
  /** column index per seg (parallel to the region's seg array). */
  assign: number[];
}

/** Pair candidate under evaluation (score + everything needed to finalize). */
interface Scored {
  kind: 'kv' | 'table' | 'lines';
  layout?: 'stacked' | 'inline';
  score: number;
  /** Prior-free score: margins compare EVIDENCE; routing priors do not count. */
  evidence: number;
  signature: string;
  pairs?: PendingPair[];
  leftovers?: Seg[];
  /** For stacked candidates: the banding that produced them (margin finalization). */
  banding?: Banding;
}


/** Does q actively RE-BIND p's material — same label segs bound to different
 *  value segs, or the same value segs claimed by a different label? A reading
 *  that merely lacks p (abstains) does not dispute it. Segment identity, not
 *  text, so duplicate label texts stay independent. */
function contradicts(p: PendingPair, q: PendingPair): boolean {
  const sameSet = (a: Seg[], b: Seg[]) => a.length === b.length && a.every((s) => b.includes(s));
  const shares = (a: Seg[], b: Seg[]) => a.some((s) => b.includes(s));
  if (shares(p.labelSegs, q.labelSegs) && !sameSet(p.valueSegs, q.valueSegs)) return true;
  if (shares(p.valueSegs, q.valueSegs) && !sameSet(p.labelSegs, q.labelSegs)) return true;
  // Cross-role rebinding: p's label used as a value elsewhere (or vice versa).
  return shares(p.labelSegs, q.valueSegs) || shares(p.valueSegs, q.labelSegs);
}

interface PendingPair {
  label: string;
  value: string;
  box: BBox;
  labelSegs: Seg[];
  valueSegs: Seg[];
  y: number;
  x: number;
  typePlaus: number;
  /** Pair-local Lowe margin (inline: vertical d2/d1; stacked: ∞ — the banding
   *  containment margin is computed globally at finalization). */
  assignMargin: number;
  /** Inline row-alignment quality in [0,1] (1 = label and value share a row,
   *  relative to the label column's own pitch). Stacked pairs: 1. */
  align: number;
}

export function interpretRegion(segs: Seg[], m: PageMetrics, opts: InterpretOptions = {}): RegionInterpretation {
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  if (segs.length < 3) return { kind: 'lines', score: w.linesScore, runnerUp: 0 };

  const rows = clusterRows(segs, m.lineHeight);
  const rowYs = rows.map((r) => median(r.map((s) => boxCenterY(s.box))));
  const votes = new Map<Seg, CellVote>();
  for (const s of segs) votes.set(s, cellVote(s.text, opts.lexicon));

  const candidates: Scored[] = [{ kind: 'lines', score: w.linesScore, evidence: w.linesScore, signature: 'lines' }];

  for (const col of columnCandidates(segs, m, w)) {
    if (col.anchors.length < 2) continue;
    const grid = buildGrid(rows, segs, col, votes);
    const stats = gridStats(rows, grid, col, m);
    const penalties = gridPenalties(stats);
    const rowVotes = grid.map((r) => groupVote(r.filter((c): c is Cell => !!c).map((c) => c.vote)));
    const gapSplit = rowGapSplit(rowYs, w);

    candidates.push(...stackedCandidates(grid, rows, rowYs, rowVotes, gapSplit, penalties, stats, w));
    const inline = inlineCandidate(segs, col, votes, penalties, m, w);
    if (inline) candidates.push(inline);
    candidates.push(tableCandidate(grid, rowVotes, stats, penalties, !!opts.tablePrior, w));
  }
  opts.onCandidates?.(candidates.map((c) => ({ kind: c.kind, layout: c.layout, score: c.score, evidence: c.evidence, signature: c.signature.slice(0, 120) })));

  // Argmax; runner-up = best among candidates that read DIFFERENTLY (margins
  // compare evidence, so routing priors are excluded from both sides).
  let best = candidates[0]!;
  for (const c of candidates) if (c.score > best.score) best = c;
  let runnerUp = 0;
  for (const c of candidates) if (c.signature !== best.signature && c.evidence > runnerUp) runnerUp = c.evidence;

  if (best.kind === 'lines') return { kind: 'lines', score: best.score, runnerUp };
  if (best.kind === 'table') return { kind: 'table', rows, score: best.score, runnerUp };

  // Interpretation margin: this kv reading vs the best NON-kv reading of the
  // region (lines is always available at the neutral score).
  const bestNonKv = Math.max(w.linesScore, ...candidates.filter((c) => c.kind !== 'kv').map((c) => c.evidence));
  const interpMargin = best.evidence / bestNonKv;
  // Geometry-tightness cap: a gap/type banding that only just cleared its own
  // margin reports that tightness in every pair's confidence.
  const bandingCap = best.banding && (best.banding.source === 'gap' || best.banding.source === 'type') ? best.banding.margin : Number.POSITIVE_INFINITY;

  const kvCands = candidates.filter((c): c is Scored & { pairs: PendingPair[] } => c.kind === 'kv' && !!c.pairs?.length && c !== best);
  const pairs: PairedKv[] = (best.pairs ?? []).map((p) => {
    // Assignment margin by CONTRADICTION: how strong is the best alternative
    // reading that re-binds this pair's segments differently? Readings that
    // merely abstain don't dispute the pair; undisputed pairs keep their
    // type-plausibility (times the interpretation margin) undiscounted.
    const disputing = kvCands.filter((c) => c.pairs.some((q) => contradicts(p, q))).map((c) => c.evidence);
    const withoutBest = disputing.length ? Math.max(...disputing) : 0;
    const margin = Math.min(withoutBest > 0 ? best.evidence / withoutBest : Number.POSITIVE_INFINITY, bandingCap, p.assignMargin);
    return {
      label: p.label,
      value: p.value,
      box: p.box,
      labelSegs: p.labelSegs,
      valueSegs: p.valueSegs,
      y: p.y,
      x: p.x,
      conf: pairConfidence(p.typePlaus, mapMargin(margin) * p.align, mapMargin(interpMargin)),
    };
  });
  pairs.sort((a, b) => a.y - b.y || a.x - b.x);
  return { kind: 'kv', layout: best.layout!, pairs, leftovers: best.leftovers ?? [], score: best.score, runnerUp };
}

/** ≤3 column clusterings: today's x0 gap clustering (parity), the centerX
 *  variant (the old 'center' anchor), and a threshold-free largest-jump x0
 *  clustering. Deduped by the per-seg assignment they induce. */
function columnCandidates(segs: Seg[], m: PageMetrics, w: PairingWeights): ColumnCandidate[] {
  const out: ColumnCandidate[] = [];
  const seen = new Set<string>();
  const push = (anchors: number[], anchorOf: (s: Seg) => number) => {
    if (!anchors.length) return;
    const assign = segs.map((s) => nearestIndex(anchors, anchorOf(s)));
    const key = assign.join(',');
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ anchors, assign });
    }
  };
  push(clusterByGap(segs.map((s) => s.x0), m.lineHeight * 2.2), (s) => s.x0);
  push(clusterByGap(segs.map((s) => boxCenterX(s.box)), m.lineHeight * 2.2), (s) => boxCenterX(s.box));
  push(jumpClusters(segs.map((s) => s.x0), w), (s) => s.x0);
  return out;
}

/** 1-D clustering by the largest multiplicative jump in consecutive sorted
 *  diffs — scale-free column discovery (no lineHeight multiple involved). */
function jumpClusters(values: number[], w: PairingWeights): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length < 2) return [];
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) diffs.push(sorted[i]! - sorted[i - 1]!);
  const split = splitGapsByJump(diffs, w.splitMargin);
  if (!split) return [];
  const clusters: number[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    if (split.bigIdx.has(i - 1)) clusters.push([sorted[i]!]);
    else clusters[clusters.length - 1]!.push(sorted[i]!);
  }
  return clusters.map((c) => c.reduce((a, b) => a + b, 0) / c.length);
}

function buildGrid(rows: Seg[][], segs: Seg[], col: ColumnCandidate, votes: Map<Seg, CellVote>): (Cell | undefined)[][] {
  const colOf = new Map<Seg, number>();
  segs.forEach((s, i) => colOf.set(s, col.assign[i]!));
  return rows.map((row) => {
    const cells: (Cell | undefined)[] = Array(col.anchors.length).fill(undefined);
    for (const s of row) {
      const c = colOf.get(s)!;
      const existing = cells[c];
      if (existing) {
        existing.segs.push(s);
        existing.segs.sort((a, b) => a.box.x0 - b.box.x0);
        existing.text = existing.segs.map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim();
        existing.box = unionBox(existing.segs.map((x) => x.box));
        existing.vote = cellVote(existing.text);
      } else {
        cells[c] = { segs: [s], text: s.text.trim(), box: s.box, vote: votes.get(s)! };
      }
    }
    return cells;
  });
}

function gridStats(rows: Seg[][], grid: (Cell | undefined)[][], col: ColumnCandidate, m: PageMetrics): GridStats {
  let totalCells = 0;
  let collidedCells = 0;
  const firstWidths: number[] = [];
  for (const row of grid) {
    const present = row.filter((c): c is Cell => !!c);
    totalCells += present.length;
    collidedCells += present.filter((c) => c.segs.length > 1).length;
    const first = present[0];
    if (first) firstWidths.push(first.box.x1 - first.box.x0);
  }
  const width = Math.max(1, m.width);
  return {
    totalCells,
    collidedCells,
    firstCellWidthShare: median(firstWidths) / width,
    colSpanShare: (Math.max(...col.anchors) - Math.min(...col.anchors)) / width,
    multiCellRows: grid.filter((row) => row.filter(Boolean).length >= 2).length,
    nRows: grid.length,
    nCols: col.anchors.length,
  };
}

function rowGapSplit(rowYs: number[], w: PairingWeights): GapSplit | null {
  const gaps: number[] = [];
  for (let i = 1; i < rowYs.length; i++) gaps.push(rowYs[i]! - rowYs[i - 1]!);
  return splitGapsByJump(gaps, w.splitMargin);
}

/** All stacked readings of the grid — one per banding candidate. */
function stackedCandidates(
  grid: (Cell | undefined)[][],
  rows: Seg[][],
  rowYs: number[],
  rowVotes: number[],
  gapSplit: GapSplit | null,
  penalties: number,
  stats: GridStats,
  w: PairingWeights,
): Scored[] {
  // Band quality: how label→values-typed rows [labelRow..lastRow] read. The
  // WORST (most label-typed) value row bounds it: a label row swallowed into a
  // band is a banding error, not an average. The band's FINAL value row is
  // exempt — a functioning label row always has its values BELOW it in the
  // band, so the last row is structurally incapable of being one; it is where
  // wrapped continuations live, and continuations ("MEDICAL WARD") often look
  // label-shaped in isolation.
  const bandQuality = (labelRowIdx: number, lastRowIdx: number): number => {
    const valueRowIdxs: number[] = [];
    for (let r = labelRowIdx + 1; r <= lastRowIdx; r++) valueRowIdxs.push(r);
    const pool = valueRowIdxs.length > 1 ? valueRowIdxs.slice(0, -1) : valueRowIdxs;
    const worstValueVote = Math.max(...pool.map((r) => rowVotes[r]!));
    return typePlausibility(rowVotes[labelRowIdx]!, worstValueVote, w.sigmaK) ** 2;
  };

  const out: Scored[] = [];
  for (const banding of bandingCandidates(rowYs, rowVotes, w.splitMargin, bandQuality)) {
    const bandScores: number[] = [];
    const pending: PendingPair[] = [];
    const used = new Set<Seg>();
    let participating = 0;

    for (const band of banding.bands) {
      if (band.length < 2) continue;
      const labelRowIdx = band[0]!;
      const valueRowIdxs = band.slice(1);
      const labelVote = rowVotes[labelRowIdx]!;
      bandScores.push(bandQuality(labelRowIdx, band[band.length - 1]!));
      // Context for the value side of every pair in this band: the band's own
      // value rows as a whole (all columns).
      const valueRowsVote = groupVote(
        valueRowIdxs.flatMap((r) => grid[r]!.filter((x): x is Cell => !!x).map((x) => x.vote)),
      );

      for (let c = 0; c < (grid[labelRowIdx]?.length ?? 0); c++) {
        const label = grid[labelRowIdx]![c];
        if (!label?.text) continue;
        const valueCells = valueRowIdxs.map((r) => grid[r]![c]).filter((x): x is Cell => !!x?.text);
        if (!valueCells.length) continue;
        const vL = blendContext(label.vote, labelVote);
        const vV = blendContext(
          { v: groupVote(valueCells.map((v) => v.vote)), strong: valueCells.some((v) => v.vote.strong) },
          valueRowsVote,
        );
        pending.push({
          label: stripColon(label.text),
          value: joinValueTexts(valueCells.map((v) => v.text)),
          box: unionBox([label.box, ...valueCells.map((v) => v.box)]),
          labelSegs: label.segs,
          valueSegs: valueCells.flatMap((v) => v.segs),
          y: boxCenterY(label.box),
          x: label.box.x0,
          typePlaus: typePlausibility(vL, vV, w.sigmaK),
          assignMargin: Number.POSITIVE_INFINITY, // stacked margins come from banding containment
          align: 1,
        });
        participating += 1 + valueCells.length;
        label.segs.forEach((s) => used.add(s));
        valueCells.forEach((v) => v.segs.forEach((s) => used.add(s)));
      }
    }

    const completeness = stats.totalCells > 0 ? participating / stats.totalCells : 0;
    const score = stackedScore({ bandScores, banding, gapSplit, nRows: grid.length, completeness, penalties }, w);
    out.push({
      kind: pending.length ? 'kv' : 'lines',
      layout: 'stacked',
      score,
      evidence: score,
      // A banding that yields no pairs READS as plain lines — same signature,
      // so it can never pose as a distinct runner-up interpretation.
      signature: pending.length ? pending.map((p) => `${p.label}=${p.value}`).join('|') : 'lines',
      pairs: pending,
      leftovers: rows.flat().filter((s) => !used.has(s)),
      banding,
    });
  }
  return out;
}

/** The inline reading: label columns claim the nearest value column to their
 *  RIGHT (mutual in x); within a pair, labels and values bind by mutual-nearest
 *  vertical assignment with a Lowe ratio AND a row-alignment quality (an inline
 *  value sits ON its label's row — measured relative to the label column's own
 *  pitch, so independent side-by-side stacks may stagger); unclaimed value segs
 *  join the pair above them, but never past the next label's own claim. */
function inlineCandidate(
  segs: Seg[],
  col: ColumnCandidate,
  votes: Map<Seg, CellVote>,
  penalties: number,
  m: PageMetrics,
  w: PairingWeights,
): Scored | null {
  const nCols = col.anchors.length;
  const byCol: Seg[][] = Array.from({ length: nCols }, () => []);
  segs.forEach((s, i) => byCol[col.assign[i]!]!.push(s));
  for (const c of byCol) c.sort((a, b) => boxCenterY(a.box) - boxCenterY(b.box));
  const colVotes = byCol.map((c) => groupVote(c.map((s) => votes.get(s)!)));

  const labelCols: number[] = [];
  const valueCols: number[] = [];
  for (let c = 0; c < nCols; c++) (colVotes[c]! > 0 ? labelCols : valueCols).push(c);
  if (!labelCols.length || !valueCols.length) return null;

  // Mutual nearest in x, directional (a printed label sits LEFT of its value).
  const x = col.anchors;
  const pairsOfCols: [number, number][] = [];
  for (const l of labelCols) {
    const right = valueCols.filter((v) => x[v]! > x[l]!);
    if (!right.length) continue;
    const v = right.reduce((a, b) => (x[a]! - x[l]! <= x[b]! - x[l]! ? a : b));
    const leftLabels = labelCols.filter((ll) => x[ll]! < x[v]!);
    const mutual = leftLabels.reduce((a, b) => (x[v]! - x[a]! <= x[v]! - x[b]! ? a : b));
    if (mutual === l) pairsOfCols.push([l, v]);
  }
  if (!pairsOfCols.length) return null;

  const pending: PendingPair[] = [];
  const used = new Set<Seg>();
  let mutualCount = 0;
  let labelCount = 0;
  const pairTypeScores: number[] = [];
  const alignFactors: number[] = [];

  for (const [lc, vc] of pairsOfCols) {
    pairTypeScores.push(typePlausibility(colVotes[lc]!, colVotes[vc]!, w.sigmaK) ** 2);
    const labels = byCol[lc]!;
    const values = byCol[vc]!;
    labelCount += labels.length;
    // The label column's own pitch is the scale for "same row": an anchor
    // value a full label-row away is not this label's value.
    const labelYs = labels.map((l) => boxCenterY(l.box)).sort((a, b) => a - b);
    const labelGaps: number[] = [];
    for (let i = 1; i < labelYs.length; i++) labelGaps.push(labelYs[i]! - labelYs[i - 1]!);
    const labelPitch = median(labelGaps) || m.pitch;

    const claimed = new Map<Seg, { label: Seg; margin: number; align: number }>();
    for (const label of labels) {
      const ly = boxCenterY(label.box);
      const ds = values.map((v) => ({ v, d: Math.abs(boxCenterY(v.box) - ly) })).sort((a, b) => a.d - b.d);
      if (!ds.length) continue;
      const nearest = ds[0]!;
      // Mutuality: the value's own nearest label must be this label.
      const back = labels
        .map((l2) => ({ l2, d: Math.abs(boxCenterY(nearest.v.box) - boxCenterY(l2.box)) }))
        .sort((a, b) => a.d - b.d)[0]!;
      if (back.l2 !== label) continue;
      const margin = ds.length > 1 ? ds[1]!.d / Math.max(nearest.d, 1e-6) : Number.POSITIVE_INFINITY;
      const align = Math.max(0, 1 - nearest.d / Math.max(labelPitch, 1e-6));
      claimed.set(nearest.v, { label, margin, align });
      mutualCount++;
    }
    // Wrapped continuations: an unclaimed value seg joins the pair above it —
    // but never past the NEXT label's claim (reading order bounds the wrap).
    const byLabel = new Map<Seg, { values: Seg[]; margin: number; align: number }>();
    for (const [v, e] of claimed) {
      const cur = byLabel.get(e.label) ?? { values: [], margin: e.margin, align: e.align };
      cur.values.push(v);
      cur.margin = Math.min(cur.margin, e.margin);
      cur.align = Math.min(cur.align, e.align);
      byLabel.set(e.label, cur);
    }
    const claimedLabels = labels.filter((l) => byLabel.has(l)); // in y order already
    for (const v of values) {
      if (claimed.has(v)) continue;
      const vy = boxCenterY(v.box);
      const above = claimedLabels.filter((l) => boxCenterY(l.box) <= vy).pop();
      if (!above) continue;
      const next = claimedLabels[claimedLabels.indexOf(above) + 1];
      if (next && vy >= boxCenterY(next.box)) continue;
      byLabel.get(above)!.values.push(v);
    }
    for (const [label, e] of byLabel) {
      const vals = e.values.sort((a, b) => boxCenterY(a.box) - boxCenterY(b.box));
      const labelText = stripColon(label.text);
      if (!labelText) continue;
      const vL = blendContext(votes.get(label)!, colVotes[lc]!);
      const vV = blendContext({ v: groupVote(vals.map((s) => votes.get(s)!)), strong: vals.some((s) => votes.get(s)!.strong) }, colVotes[vc]!);
      alignFactors.push(e.align);
      pending.push({
        label: labelText,
        value: joinValueTexts(vals.map((s) => s.text.trim()).filter(Boolean)),
        box: unionBox([label.box, ...vals.map((s) => s.box)]),
        labelSegs: [label],
        valueSegs: vals,
        y: boxCenterY(label.box),
        x: label.box.x0,
        typePlaus: typePlausibility(vL, vV, w.sigmaK),
        assignMargin: e.margin,
        align: e.align,
      });
      used.add(label);
      vals.forEach((s) => used.add(s));
    }
  }
  if (!pending.length) return null;

  const completeness = segs.length > 0 ? used.size / segs.length : 0;
  const mutuality = labelCount > 0 ? mutualCount / labelCount : 0;
  const alignment = alignFactors.length ? alignFactors.reduce((a, b) => a + b, 0) / alignFactors.length : 0;
  const score = inlineScore({ pairTypeScores, mutuality, completeness, penalties }, w) * alignment;
  return {
    kind: 'kv',
    layout: 'inline',
    score,
    evidence: score,
    signature: pending.map((p) => `${p.label}=${p.value}`).join('|'),
    pairs: pending,
    leftovers: segs.filter((s) => !used.has(s)),
  };
}

function tableCandidate(
  grid: (Cell | undefined)[][],
  rowVotes: number[],
  stats: GridStats,
  penalties: number,
  tablePrior: boolean,
  w: PairingWeights,
): Scored {
  // A data table has ONE label-typed row — the header, on top. Every bit an
  // interior row matches the first row's label-typedness is evidence of
  // REPEATING label rows (stacked records), not a header — so the header
  // credit is the first row's vote LESS the most label-typed interior row
  // (clamped: decisively value-typed interiors never inflate the header).
  const maxInterior = rowVotes.length > 1 ? Math.max(...rowVotes.slice(1)) : 0;
  const headerScore = sigma((rowVotes[0] ?? 0) - Math.max(0, maxInterior), w.sigmaK);
  // Cell-count-weighted homogeneity: a single-cell column carries almost no
  // evidence and must not prop the mean up with its neutral 0.5.
  let num = 0;
  let den = 0;
  for (let c = 0; c < stats.nCols; c++) {
    const colCells = grid.map((row) => row[c]).filter((x): x is Cell => !!x);
    num += signAlignment(colCells.map((x) => x.vote)) * colCells.length;
    den += colCells.length;
  }
  const columnHomogeneity = den > 0 ? num / den : 0.5;
  const fill = stats.nRows * stats.nCols > 0 ? stats.totalCells / (stats.nRows * stats.nCols) : 0;
  const shape = fill * Math.min(1, stats.nRows / 3);
  const evidence = tableScore({ headerScore, columnHomogeneity, shape, penalties, tablePrior: false }, w);
  const score = tablePrior ? tableScore({ headerScore, columnHomogeneity, shape, penalties, tablePrior: true }, w) : evidence;
  return { kind: 'table', score, evidence, signature: 'table' };
}

/** kv interpretation → Blocks (pairs as kv with pairConf; leftovers as one
 *  paragraph per segment), merged in reading order. */
export function kvInterpretationToBlocks(interp: Extract<RegionInterpretation, { kind: 'kv' }>): Block[] {
  const units: { y: number; x: number; block: Block }[] = interp.pairs.map((p) => ({
    y: p.y,
    x: p.x,
    block: { kind: 'kv', label: p.label, value: p.value, box: p.box, pairConf: p.conf } as Block,
  }));
  for (const s of interp.leftovers) {
    const text = s.text.trim();
    if (!text) continue;
    units.push({ y: boxCenterY(s.box), x: s.box.x0, block: { kind: 'paragraph', text, box: s.box } });
  }
  units.sort((a, b) => a.y - b.y || a.x - b.x);
  return units.map((u) => u.block);
}
