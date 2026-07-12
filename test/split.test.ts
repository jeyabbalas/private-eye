/**
 * Split-ratio clamp (split.ts). The divider persists its ratio; whatever comes
 * back from storage (or a drag) must land in the usable 0.2–0.8 band.
 */
import { describe, it, expect } from 'vitest';
import { clampRatio } from '../src/review/split.ts';

describe('clampRatio', () => {
  it('passes reasonable ratios through', () => {
    expect(clampRatio(0.5)).toBe(0.5);
    expect(clampRatio(0.2)).toBe(0.2);
    expect(clampRatio(0.8)).toBe(0.8);
    expect(clampRatio(0.34)).toBeCloseTo(0.34, 10);
  });

  it('clamps to the 0.2–0.8 band', () => {
    expect(clampRatio(0)).toBe(0.2);
    expect(clampRatio(-3)).toBe(0.2);
    expect(clampRatio(0.95)).toBe(0.8);
    expect(clampRatio(42)).toBe(0.8);
  });

  it('falls back to 50/50 for garbage', () => {
    expect(clampRatio(Number.NaN)).toBe(0.5);
    expect(clampRatio(Number.POSITIVE_INFINITY)).toBe(0.5);
    expect(clampRatio(Number.NEGATIVE_INFINITY)).toBe(0.5);
  });
});
