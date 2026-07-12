/**
 * Threshold-free 1-D structure discovery for the pairing interpreter.
 *
 * The core insight (verified on the broken fixtures): intra-record vs
 * inter-record row gaps are NOT separable by any fixed multiple of any single
 * page scale — PP-OCR's det-box height is deflated (≈0.5× the row pitch) and
 * real grids put the two gap populations within 1–2 px of any absolute cutoff.
 * They ARE separable relative to each other: sort the gaps and cut at the
 * largest multiplicative jump, accepting only when the two clusters are
 * genuinely apart (a dimensionless margin) and each is internally tight.
 */

export interface GapSplit {
  /** Indices (into the original gaps array) of the BIG (inter-band) gaps. */
  bigIdx: Set<number>;
  /** min(big)/max(small): the separation between the clusters (≥ minMargin). */
  margin: number;
}

const EPS = 1e-9;

/**
 * Split gaps into small (intra) vs big (inter) clusters at the largest
 * multiplicative jump. Valid only when
 *   margin = min(big)/max(small) ≥ minMargin, and
 *   each cluster's own spread (max/min) ≤ margin (clusters tighter than their
 *   separation — otherwise there is no bimodal structure, just noise).
 */
export function splitGapsByJump(gaps: number[], minMargin: number): GapSplit | null {
  if (gaps.length < 2) return null;
  const order = gaps.map((g, i) => ({ g: Math.max(g, EPS), i })).sort((a, b) => a.g - b.g);
  let cut = -1;
  let margin = 0;
  for (let k = 0; k + 1 < order.length; k++) {
    const r = order[k + 1]!.g / order[k]!.g;
    if (r > margin) {
      margin = r;
      cut = k;
    }
  }
  if (cut < 0 || margin < minMargin) return null;
  const small = order.slice(0, cut + 1);
  const big = order.slice(cut + 1);
  const smallSpread = small[small.length - 1]!.g / small[0]!.g;
  const bigSpread = big[big.length - 1]!.g / big[0]!.g;
  if (smallSpread > margin || bigSpread > margin) return null;
  return { bigIdx: new Set(big.map((e) => e.i)), margin };
}

export interface Banding {
  /** Bands of row indices (consecutive, exhaustive). */
  bands: number[][];
  source: 'single' | 'gap' | 'type' | 'dp' | 'perRow';
  /** Lowe-style support for THIS banding's cuts (gap margin for 'gap';
   *  derived from content for the others — see score.ts). */
  margin: number;
}

/**
 * Candidate bandings of the rows of a stacked grid:
 *  - single band (one record),
 *  - the gap-split banding (when the gap distribution is genuinely bimodal),
 *  - type-alternation banding (band break where a label-typed row follows a
 *    value-typed row — the safety net when gaps are uniform),
 *  - the DP-optimal banding (maximize coverage-weighted band quality, single-
 *    row bands allowed at zero) — the safety net when banner/stamp rows glued
 *    to the grid by the layout box poison the gap distribution: junk rows fall
 *    into single-row bands (→ leftovers) and the true records pair,
 *  - the per-row degenerate banding, enumerated deliberately so that the old
 *    failure mode ("every row its own band → paragraph soup") has to WIN a
 *    fair score fight to be emitted — and it never can (zero completeness).
 */
export function bandingCandidates(rowYs: number[], rowVotes: number[], minMargin: number, bandQuality?: (labelRow: number, lastRow: number) => number): Banding[] {
  const n = rowYs.length;
  const out: Banding[] = [];
  const seen = new Set<string>();
  const push = (bands: number[][], source: Banding['source'], margin: number) => {
    const key = bands.map((b) => b.join(',')).join('|');
    if (bands.length && !seen.has(key)) {
      seen.add(key);
      out.push({ bands, source, margin });
    }
  };

  const all = [Array.from({ length: n }, (_, i) => i)];
  push(all, 'single', 1);

  const gaps: number[] = [];
  for (let i = 1; i < n; i++) gaps.push(rowYs[i]! - rowYs[i - 1]!);
  const split = splitGapsByJump(gaps, minMargin);
  if (split) {
    const bands: number[][] = [[0]];
    for (let i = 1; i < n; i++) {
      if (split.bigIdx.has(i - 1)) bands.push([i]);
      else bands[bands.length - 1]!.push(i);
    }
    push(bands, 'gap', split.margin);
  }

  // Type alternation: cut where a label-typed row follows a value-typed row.
  const bands: number[][] = [[0]];
  for (let i = 1; i < n; i++) {
    if (rowVotes[i]! > 0 && rowVotes[i - 1]! < 0) bands.push([i]);
    else bands[bands.length - 1]!.push(i);
  }
  // Content-derived support: how decisive were the votes across the cuts.
  const cutStrengths: number[] = [];
  for (let i = 1; i < n; i++) {
    if (rowVotes[i]! > 0 && rowVotes[i - 1]! < 0) cutStrengths.push(Math.min(rowVotes[i]!, -rowVotes[i - 1]!));
  }
  const typeMargin = 1 + (cutStrengths.length ? cutStrengths.reduce((a, b) => a + b, 0) / cutStrengths.length : 0);
  push(bands, 'type', typeMargin);

  // DP-optimal segmentation: best[j] = best total quality of rows [0..j).
  // Quality of a multi-row band is supplied by the caller (content-based, in
  // [0,1]); the NEUTRAL point σ(0)·σ(0) = 0.25 (a coin-flip label/value read,
  // derived — not tuned) is subtracted before coverage-weighting, so a band
  // must positively BEAT chance to be worth forming — otherwise its rows stay
  // single-row bands (leftovers). This is what peels banner/stamp rows.
  if (bandQuality) {
    const NEUTRAL = 0.25;
    const best: number[] = Array(n + 1).fill(0);
    const cutAt: number[] = Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      best[j] = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < j; i++) {
        const q = j - i >= 2 ? (bandQuality(i, j - 1) - NEUTRAL) * (j - i) : 0;
        const v = best[i]! + q;
        if (v > best[j]!) {
          best[j] = v;
          cutAt[j] = i;
        }
      }
    }
    const dpBands: number[][] = [];
    for (let j = n; j > 0; j = cutAt[j]!) {
      dpBands.unshift(Array.from({ length: j - cutAt[j]! }, (_, k) => cutAt[j]! + k));
    }
    push(dpBands, 'dp', 1);
  }

  push(Array.from({ length: n }, (_, i) => [i]), 'perRow', 1);
  return out;
}
