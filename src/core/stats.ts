/** Pure numeric helpers shared by engines, the structure layer, and eval. */

/** Maps a raw OCR character confidence (and its glyph) to calibrated P(correct).
 *  Defined here (core) so both the engine calibrator and the structure-layer
 *  uncertainty builders can reference it without a cross-layer import. */
export type CalibrateFn = (rawConf: number, ch: string) => number;

/**
 * Geometric mean = exp(mean(log x)). For a sequence of per-token confidences this
 * is the length-normalized sequence probability (the product of probabilities,
 * normalized by length) — the statistically natural aggregation, unlike the
 * arithmetic mean which over-weights many easy tokens against one uncertain one.
 * Empty → 0. Inputs are clamped away from 0 to keep the log finite.
 */
export function geoMean(xs: number[]): number {
  if (!xs.length) return 0;
  let sum = 0;
  for (const x of xs) sum += Math.log(Math.max(x, 1e-12));
  return Math.exp(sum / xs.length);
}

/**
 * Linear-interpolated quantile q∈[0,1] of xs (q=0.1 → 10th percentile). Used for
 * a robust "worst character" signal (p10) that is less brittle than a single min.
 * Empty → 0.
 */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 1) return s[0]!;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
