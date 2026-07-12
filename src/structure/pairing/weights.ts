/**
 * Every tunable constant of the pairing interpreter, in ONE place so Stage 3
 * (scripts/pairing-fit.ts, FUNSD label+linking) can sweep them without any
 * refactoring. Rules of this file:
 *
 *  - DIMENSIONLESS ONLY: ratios, mixture weights, cue strengths on [-1,1].
 *    No pixels, no lineHeight multiples — structure decisions are made
 *    relative to each grid's own geometry (gap distributions, mutual-nearest
 *    assignments), never against absolute scales.
 *  - NOT fitted to the pathology fixtures. Those are transfer-only holdouts
 *    (see README "Evaluation"); defaults below are principled priors.
 */

export interface PairingWeights {
  /** Gap-split validity: the smallest accepted multiplicative separation
   *  min(interGaps)/max(intraGaps) between the two gap clusters. 1 = clusters
   *  touch. Sweepable on FUNSD; 1.3 = "inter-record gaps are at least a third
   *  wider than intra-record gaps before geometry alone may split bands". */
  splitMargin: number;
  /** Stacked-kv score mixture (alternation ≈ content, geom ≈ gap agreement). */
  stacked: { alternation: number; geom: number; completeness: number };
  /** Inline-kv score mixture. */
  inline: { pairType: number; mutuality: number; completeness: number };
  /** Table score mixture + the layout-model prior added when the layout engine
   *  itself called the region a table. */
  table: { header: number; homogeneity: number; shape: number; prior: number };
  /** The fixed neutral score of the plain-lines reading — the bar every
   *  structural interpretation must beat. Also the semantic acceptance bar for
   *  single-line kv parsing (kvline.ts): the neutral point of the type score. */
  linesScore: number;
  /** Logistic steepness mapping type votes in [-1,1] to probabilities. */
  sigmaK: number;
}

export const DEFAULT_WEIGHTS: PairingWeights = {
  splitMargin: 1.3,
  stacked: { alternation: 0.5, geom: 0.25, completeness: 0.25 },
  inline: { pairType: 0.5, mutuality: 0.25, completeness: 0.25 },
  table: { header: 0.4, homogeneity: 0.4, shape: 0.2, prior: 0.1 },
  linesScore: 0.5,
  sigmaK: 3,
};

/** Logistic squash of a type vote v ∈ [-1,1] (positive = label-typed). */
export function sigma(v: number, k: number = DEFAULT_WEIGHTS.sigmaK): number {
  return 1 / (1 + Math.exp(-k * v));
}

/** Map a Lowe-style margin m ∈ [1,∞) (winner/runner-up separation) onto [0,1).
 *  m = 1 (tie) → 0; m = 1.3 → 0.41; m = 2 → 0.75. */
export function mapMargin(m: number): number {
  const mm = Math.max(1, m);
  return 1 - 1 / (mm * mm);
}
