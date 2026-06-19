/**
 * Zoom-to-box math (scan-view.ts). Pins the rule the scan viewport uses to frame a
 * flagged region: fit the box to ~80% of the viewport, centered, clamped between
 * fit-to-width (the floor) and the max zoom.
 */
import { describe, it, expect } from 'vitest';
import { zoomToBoxTransform } from '../src/review/scan-view.ts';
import type { BBox } from '../src/core/types.ts';

const b = (x0: number, y0: number, x1: number, y1: number): BBox => ({ x0, y0, x1, y1 });

describe('zoomToBoxTransform', () => {
  it('fits a small box to ~80% of the viewport and centers it', () => {
    const t = zoomToBoxTransform(400, 300, 1000, 1000, b(100, 100, 200, 200));
    // 0.8 * min(400/100, 300/100) = 2.4 (above the 0.4 fit floor, below max 8)
    expect(t.scale).toBeCloseTo(2.4, 5);
    // center (150,150) maps to viewport center (200,150)
    expect(t.tx).toBeCloseTo(200 - 150 * 2.4, 5);
    expect(t.ty).toBeCloseTo(150 - 150 * 2.4, 5);
  });

  it('never zooms out past fit-to-width for a near-full-page box', () => {
    const t = zoomToBoxTransform(400, 300, 1000, 1000, b(0, 0, 1000, 1000));
    expect(t.scale).toBeCloseTo(400 / 1000, 5); // the fit floor
  });

  it('caps at the maximum zoom for a tiny box', () => {
    const t = zoomToBoxTransform(400, 300, 1000, 1000, b(0, 0, 1, 1), 8);
    expect(t.scale).toBe(8);
  });

  it('stays finite when the viewport has not been measured yet', () => {
    const t = zoomToBoxTransform(0, 0, 1000, 1000, b(100, 100, 200, 200));
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(t.tx)).toBe(true);
    expect(Number.isFinite(t.ty)).toBe(true);
  });
});
