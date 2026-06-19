/**
 * Pure numeric aggregations used for the per-line/block triage signals. geoMean is
 * the length-normalized sequence probability; quantile is the robust "worst
 * character" (p10). Both must stay finite and order-independent.
 */
import { describe, it, expect } from 'vitest';
import { geoMean, quantile } from '../src/core/stats.ts';

describe('geoMean', () => {
  it('returns 0 for empty input', () => {
    expect(geoMean([])).toBe(0);
  });

  it('returns the single value for one element', () => {
    expect(geoMean([0.7])).toBeCloseTo(0.7, 10);
  });

  it('is the length-normalized product of probabilities (= nth root of the product)', () => {
    expect(geoMean([0.25, 0.81])).toBeCloseTo(Math.sqrt(0.25 * 0.81), 10); // 0.45
  });

  it('equals the common value when all inputs are equal', () => {
    expect(geoMean([0.5, 0.5, 0.5])).toBeCloseTo(0.5, 10);
  });

  it('clamps zeros away from -Infinity so the result stays finite and near 0', () => {
    const g = geoMean([0, 1]); // sqrt(1e-12 * 1) = 1e-6
    expect(Number.isFinite(g)).toBe(true);
    expect(g).toBeGreaterThan(0);
    expect(g).toBeLessThan(1e-5);
  });
});

describe('quantile', () => {
  it('returns 0 for empty input', () => {
    expect(quantile([], 0.1)).toBe(0);
  });

  it('returns the single value regardless of q', () => {
    expect(quantile([0.42], 0.1)).toBe(0.42);
  });

  it('computes the median (p50)', () => {
    expect(quantile([0.1, 0.5, 0.9], 0.5)).toBeCloseTo(0.5, 10);
  });

  it('linearly interpolates between the bracketing samples', () => {
    // sorted [0, 10]: pos = 0.1*(2-1) = 0.1 -> 0 + (10-0)*0.1 = 1
    expect(quantile([0, 10], 0.1)).toBeCloseTo(1, 10);
    expect(quantile([0, 10], 0.9)).toBeCloseTo(9, 10);
  });

  it('sorts unsorted input before indexing', () => {
    const xs = [5, 1, 4, 2, 3]; // sorted [1,2,3,4,5]
    expect(quantile(xs, 0)).toBe(1);
    expect(quantile(xs, 1)).toBe(5);
    expect(quantile(xs, 0.1)).toBeCloseTo(1.4, 10); // pos 0.4 -> 1 + (2-1)*0.4
  });
});
