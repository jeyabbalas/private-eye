/**
 * Statistical core of the uncertainty-calibration harness — pure, dependency-free,
 * unit-testable. `scripts/calibrate-uncertainty.ts` runs the OCR engine over the
 * corpus and feeds (confidence, correct) pairs through these functions to fit the
 * isotonic map, measure calibration/discrimination, and apply the SHIP/DROP gate.
 *
 * Why these and not "accuracy": a calibration map captures the model's
 * *self-knowledge* — does a softmax of 0.9 actually mean ~90% correct? That
 * relationship transfers across domains far better than accuracy does, which is
 * what lets us fit on public document OCR (FUNSD/SROIE) and trust the result on
 * medical scans we have no public ground truth for.
 *
 * The gate ("ship a signal only if it is demonstrably informative") is the
 * mechanical enforcement of the owner's rule: no output over an unhelpful one.
 */
import { diffChars } from 'diff';
import type { IsotonicPoint } from '../engines/ppocr/calibration.ts';

export type { IsotonicPoint };

/** One predicted character labelled against ground truth. `conf` is the raw
 *  CTC max-softmax for that glyph; `correct` is whether it survived alignment. */
export interface CharLabel {
  ch: string;
  conf: number;
  correct: boolean;
}

// ── Character alignment ──────────────────────────────────────────────────────

// Length-preserving glyph fold (variants of the same mark compare equal, case is
// ignored) so cosmetic differences don't count as recognition errors. Crucially
// it is 1:1 — every predicted char maps to exactly one comparison char — so the
// diff's char positions stay aligned to the per-char confidence array. (We can't
// use normalize.ts's normalizeFold here: its NFKC + whitespace-collapse change
// length and would desync the confidences.)
const DASH_CHARS = '‐‑‒–—―−';
const SQUOTE_CHARS = '‘’‚‛′';
const DQUOTE_CHARS = '“”„‟″';

function foldChar(ch: string): string {
  if (DASH_CHARS.includes(ch)) return '-';
  if (SQUOTE_CHARS.includes(ch)) return "'";
  if (DQUOTE_CHARS.includes(ch)) return '"';
  const lower = ch.toLowerCase();
  // Defensive: keep it 1:1. The OCR Latin charset never lowercases to 2+ chars,
  // but ß→"ss" etc. would desync indexing, so fall back to the raw glyph.
  return lower.length === 1 ? lower : ch;
}

function foldString(s: string): string {
  let out = '';
  for (const ch of s) out += foldChar(ch);
  return out;
}

/**
 * Align a predicted line (with its per-char confidences) to ground truth and
 * label each PREDICTED character correct/wrong. Uses Myers char diff over the
 * length-preserving fold of both strings:
 *   - common run  → that predicted char matched GT          → correct
 *   - "added" run → predicted char absent from GT (sub/ins) → wrong
 *   - "removed" run → GT char with no prediction (deletion) → no predicted char
 *     to label, so it produces no CharLabel (omissions are scored elsewhere).
 * Exactly one CharLabel is emitted per predicted char, in order, so the labels
 * line up 1:1 with `predConf` and with the chars of `pred`.
 */
export function alignChars(pred: string, predConf: number[], gt: string): CharLabel[] {
  const chars = [...pred];
  if (predConf.length !== chars.length) {
    // Honest refusal: without a 1:1 confidence array we cannot attach a score to
    // each label, so we emit nothing rather than a misaligned guess.
    return [];
  }
  const parts = diffChars(foldString(gt), foldString(pred));
  const labels: CharLabel[] = [];
  let pi = 0; // cursor into the predicted chars / predConf
  for (const part of parts) {
    if (part.removed) continue; // GT-only: no predicted char here
    const correct = !part.added; // common run ⇒ matched; added run ⇒ wrong
    // part.value is over the FOLDED string, but fold is 1:1 so its length equals
    // the number of original predicted chars this run covers.
    for (let k = 0; k < part.value.length && pi < chars.length; k++, pi++) {
      labels.push({ ch: chars[pi]!, conf: predConf[pi]!, correct });
    }
  }
  return labels;
}

// ── Isotonic regression (pool-adjacent-violators) ────────────────────────────

interface PavBlock {
  xMin: number;
  xMax: number;
  sumY: number;
  w: number;
}

function pushPoint(pts: IsotonicPoint[], x: number, y: number): void {
  const last = pts[pts.length - 1];
  if (last && last.x === x && last.y === y) return; // drop exact duplicate
  pts.push({ x, y });
}

/**
 * Fit a monotone non-decreasing map confidence → P(correct) by pool-adjacent-
 * violators (the isotonic-regression MLE under monotonicity). Returns breakpoints
 * for piecewise-linear interpolation by `interpIsotonic` — one flat segment per
 * pooled block, ramps between blocks. Monotone by construction.
 *
 * Why isotonic and not Platt/temperature scaling: the rec ONNX head emits
 * POST-softmax probabilities (no logits), so there is no temperature to scale;
 * and CTC confidence is peaky/over-confident near 1.0 in a non-sigmoidal way that
 * a 1-parameter map can't correct. Isotonic makes no shape assumption.
 */
export function fitIsotonic(scores: number[], labels: boolean[]): IsotonicPoint[] {
  const n = scores.length;
  if (n === 0) return [];
  const order = [...Array(n).keys()].sort((a, b) => scores[a]! - scores[b]!);
  const blocks: PavBlock[] = [];
  for (const i of order) {
    blocks.push({ xMin: scores[i]!, xMax: scores[i]!, sumY: labels[i] ? 1 : 0, w: 1 });
    // Merge left while the previous block violates monotonicity, OR shares an x
    // with this one (ties must pool to a single value at that x).
    while (blocks.length >= 2) {
      const b = blocks[blocks.length - 1]!;
      const a = blocks[blocks.length - 2]!;
      const tie = a.xMax === b.xMin;
      if (!tie && a.sumY / a.w <= b.sumY / b.w + 1e-12) break;
      a.xMax = b.xMax;
      a.sumY += b.sumY;
      a.w += b.w;
      blocks.pop();
    }
  }
  const pts: IsotonicPoint[] = [];
  for (const b of blocks) {
    const y = b.sumY / b.w;
    pushPoint(pts, b.xMin, y);
    if (b.xMax !== b.xMin) pushPoint(pts, b.xMax, y);
  }
  return pts;
}

// ── Calibration error (reliability) ──────────────────────────────────────────

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanScore: number; // mean predicted confidence in the bin
  meanLabel: number; // observed accuracy in the bin
}

export interface Reliability {
  ece: number; // expected calibration error (lower is better)
  bins: ReliabilityBin[];
}

/**
 * Expected Calibration Error + per-bin reliability table. ECE = Σ (n_b/N)·|mean
 * confidence − observed accuracy| over equal-width bins. A well-calibrated map
 * has ECE≈0; raw CTC confidence will show a tall over-confident bin near 1.0.
 */
export function reliability(scores: number[], labels: boolean[], nBins = 10): Reliability {
  const acc = Array.from({ length: nBins }, () => ({ n: 0, sScore: 0, sLabel: 0 }));
  for (let i = 0; i < scores.length; i++) {
    let b = Math.floor(scores[i]! * nBins);
    if (b < 0) b = 0;
    if (b >= nBins) b = nBins - 1;
    acc[b]!.n++;
    acc[b]!.sScore += scores[i]!;
    acc[b]!.sLabel += labels[i] ? 1 : 0;
  }
  const N = scores.length || 1;
  let ece = 0;
  const bins = acc.map((a, i) => {
    const meanScore = a.n ? a.sScore / a.n : 0;
    const meanLabel = a.n ? a.sLabel / a.n : 0;
    ece += (a.n / N) * Math.abs(meanScore - meanLabel);
    return { lo: i / nBins, hi: (i + 1) / nBins, n: a.n, meanScore, meanLabel };
  });
  return { ece, bins };
}

/**
 * Brier score = mean squared error between the predicted P(correct) and the
 * outcome (1 = correct, 0 = wrong). A *strictly proper* scoring rule: it is
 * minimized only by the true probabilities, so — unlike ECE, which only sees
 * calibration — it rewards calibration AND discrimination in one number. It is
 * the cleanest single summary of "are these good probabilities?". Lower is
 * better: 0 = perfect, 0.25 = always predicting 0.5, 1 = confidently wrong.
 *
 * Because the isotonic map is monotone it leaves the ranking (and thus AUROC)
 * intact, so the raw→calibrated Brier *reduction* is attributable to better
 * calibration rather than better discrimination — which is exactly the
 * improvement the calibration step is supposed to deliver.
 */
export function brier(scores: number[], labels: boolean[]): number {
  if (scores.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < scores.length; i++) {
    const d = scores[i]! - (labels[i] ? 1 : 0);
    s += d * d;
  }
  return s / scores.length;
}

// ── Discrimination (AUROC / AUPRC) ───────────────────────────────────────────

/**
 * AUROC of confidence predicting correctness = P(conf of a correct char > conf
 * of a wrong char). Computed via the tie-averaged rank-sum (Mann–Whitney U), so
 * it's exact with ties. 0.5 = confidence is uninformative; this is the gate's
 * discrimination criterion. Returns 0.5 (neutral) when one class is absent.
 */
export function auroc(scores: number[], labels: boolean[]): number {
  let nPos = 0;
  for (const l of labels) if (l) nPos++;
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;
  const idx = [...Array(scores.length).keys()].sort((a, b) => scores[a]! - scores[b]!);
  const ranks = new Array<number>(scores.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]!]! === scores[idx[i]!]!) j++;
    const avg = (i + 1 + (j + 1)) / 2; // average of 1-based ranks across the tie
    for (let k = i; k <= j; k++) ranks[idx[k]!] = avg;
    i = j + 1;
  }
  let sumPos = 0;
  for (let k = 0; k < labels.length; k++) if (labels[k]) sumPos += ranks[k]!;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/**
 * Average Precision for ERROR detection (positive class = wrong char, ranked by
 * ascending confidence so the least-confident glyph is the top suspect). This is
 * the metric that matters to the product: errors are rare, and we want them
 * concentrated where the expert looks first. Report-only (the gate uses AUROC).
 * Returns 1 when the slice has no errors (nothing to detect).
 */
export function auprc(scores: number[], labels: boolean[]): number {
  const arr = scores
    .map((s, i) => ({ s, err: labels[i] ? 0 : 1 }))
    .sort((a, b) => a.s - b.s); // ascending confidence: top suspects first
  let P = 0;
  for (const x of arr) P += x.err;
  if (P === 0) return 1;
  let tp = 0;
  let fp = 0;
  let ap = 0;
  let prevRecall = 0;
  for (const x of arr) {
    if (x.err) tp++;
    else fp++;
    const recall = tp / P;
    if (recall > prevRecall) {
      ap += (recall - prevRecall) * (tp / (tp + fp));
      prevRecall = recall;
    }
  }
  return ap;
}

// ── Review-budget curve (the product-facing efficiency metric) ────────────────

export interface BudgetPoint {
  budget: number; // fraction of characters reviewed (worst-confidence first)
  errorsCaught: number; // fraction of all errors found within that budget
}

export interface ReviewBudget {
  points: BudgetPoint[];
  auc: number; // area under the curve; ~0.5 = random triage, →1 = errors front-loaded
}

/**
 * "Review the worst X% of characters by confidence → catch Y% of the errors."
 * Directly answers how much expert attention the uncertainty signal saves. AUC
 * near 1 means low confidence reliably flags the genuine mistakes.
 */
export function reviewBudgetCurve(scores: number[], labels: boolean[], steps = 20): ReviewBudget {
  const arr = scores
    .map((s, i) => ({ s, err: labels[i] ? 0 : 1 }))
    .sort((a, b) => a.s - b.s); // worst confidence reviewed first
  const n = arr.length;
  let P = 0;
  const cum: number[] = [];
  for (const x of arr) {
    P += x.err;
    cum.push(P);
  }
  const points: BudgetPoint[] = [{ budget: 0, errorsCaught: 0 }];
  for (let s = 1; s <= steps; s++) {
    const budget = s / steps;
    const k = Math.round(budget * n);
    const caught = k === 0 ? 0 : cum[k - 1]!;
    points.push({ budget, errorsCaught: P ? caught / P : 0 });
  }
  let auc = 0;
  for (let i = 1; i < points.length; i++) {
    auc += (points[i]!.budget - points[i - 1]!.budget) * (points[i]!.errorsCaught + points[i - 1]!.errorsCaught) / 2;
  }
  return { points, auc };
}

// ── Cluster bootstrap (CI honest about within-document correlation) ───────────

export interface CI {
  point: number;
  lo: number;
  hi: number;
}

// ── The ship/drop gate (mechanical "no output over an unhelpful one") ─────────

/**
 * A signal ships only if, on the HELD-OUT split, it both discriminates errors and
 * is honestly calibrated, AND it does not collapse on the transfer (medical)
 * domain. Thresholds are deliberately conservative — a dropped signal is excluded
 * from calibration.json, so the runtime finds nothing to load and emits no
 * uncertainty for it (raw peaky softmax is never shown as if it were calibrated).
 */
export const GATE = {
  /** Confidence must separate correct from wrong meaningfully (0.5 = useless). */
  MIN_AUROC: 0.65,
  /** …and robustly: the cluster-bootstrap lower 95% bound must clear chance. */
  MIN_AUROC_CI_LOWER: 0.5,
  /** Post-isotonic miscalibration ceiling. */
  MAX_ECE: 0.05,
  /** Transfer (medical) must not drop to chance — else the map doesn't carry over. */
  MIN_TRANSFER_AUROC: 0.5,
} as const;

export interface GateInput {
  heldOutAuroc: CI; // cluster-bootstrap over held-out documents
  eceRaw: number; // held-out, before calibration
  eceCal: number; // held-out, after the fitted isotonic map
  transferAuroc: number[]; // per transfer domain (point estimates)
  nErrors: number; // held-out error events — too few ⇒ estimates unreliable
}

/** Minimum held-out error events for the metrics to mean anything (plan: ≥~500). */
export const MIN_ERROR_EVENTS = 100;

export interface GateResult {
  ship: boolean;
  reasons: string[]; // why it was DROPPED (empty when shipped)
}

export function gateSignal(m: GateInput): GateResult {
  const reasons: string[] = [];
  if (m.nErrors < MIN_ERROR_EVENTS) {
    reasons.push(`only ${m.nErrors} held-out error events (< ${MIN_ERROR_EVENTS}); estimates unreliable`);
  }
  if (m.heldOutAuroc.point < GATE.MIN_AUROC) {
    reasons.push(`held-out AUROC ${m.heldOutAuroc.point.toFixed(3)} < ${GATE.MIN_AUROC}`);
  }
  if (m.heldOutAuroc.lo <= GATE.MIN_AUROC_CI_LOWER) {
    reasons.push(`AUROC 95% CI lower ${m.heldOutAuroc.lo.toFixed(3)} not > ${GATE.MIN_AUROC_CI_LOWER}`);
  }
  if (m.eceCal > GATE.MAX_ECE) {
    reasons.push(`post-isotonic ECE ${m.eceCal.toFixed(3)} > ${GATE.MAX_ECE}`);
  }
  if (m.eceCal > m.eceRaw + 1e-9) {
    reasons.push(`calibration did not improve ECE (${m.eceCal.toFixed(3)} ≥ raw ${m.eceRaw.toFixed(3)})`);
  }
  for (const a of m.transferAuroc) {
    if (a < GATE.MIN_TRANSFER_AUROC) {
      reasons.push(`transfer AUROC ${a.toFixed(3)} collapsed below ${GATE.MIN_TRANSFER_AUROC}`);
    }
  }
  return { ship: reasons.length === 0, reasons };
}

/**
 * Percentile bootstrap CI that resamples DOCUMENTS (not characters) with
 * replacement — characters within a page are correlated (same scan quality, same
 * font), so a naive per-char bootstrap would report a CI several times too tight
 * and the gate's "lower CI > 0.5" check would be meaningless. `groups` is one
 * array of items per document; `stat` is computed on the pooled items.
 *
 * `rng` is injectable so unit tests are deterministic.
 */
export function bootstrapCI<T>(
  groups: T[][],
  stat: (items: T[]) => number,
  opts: { B?: number; alpha?: number; rng?: () => number } = {},
): CI {
  const B = opts.B ?? 1000;
  const alpha = opts.alpha ?? 0.05;
  const rng = opts.rng ?? Math.random;
  const point = stat(groups.flat());
  const G = groups.length;
  if (G === 0) return { point, lo: point, hi: point };
  const samples: number[] = [];
  for (let b = 0; b < B; b++) {
    const pool: T[] = [];
    for (let g = 0; g < G; g++) {
      const pick = groups[Math.floor(rng() * G)]!;
      for (const it of pick) pool.push(it);
    }
    samples.push(stat(pool));
  }
  samples.sort((a, b) => a - b);
  const loIdx = Math.max(0, Math.floor((alpha / 2) * B));
  const hiIdx = Math.min(B - 1, Math.ceil((1 - alpha / 2) * B) - 1);
  return { point, lo: samples[loIdx] ?? point, hi: samples[hiIdx] ?? point };
}
