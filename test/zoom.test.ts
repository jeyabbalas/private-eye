/**
 * Zoom + pan math (scan-view.ts). Pins the rule the scan viewport uses to frame a
 * flagged region — fit the box to ~80% of the viewport, centered, clamped between
 * fit-to-width (the floor) and the max zoom — plus the pan clamp and the
 * whole-page zoom-out floor.
 */
import { describe, it, expect } from 'vitest';
import { clampOffsets, minScaleFor, zoomToBoxTransform } from '../src/review/scan-view.ts';
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

describe('minScaleFor', () => {
  it('floors a portrait page at its height fit (whole page visible)', () => {
    // 400×300 viewport, 1000×1400 page: width fit 0.4, height fit ~0.214
    expect(minScaleFor(400, 300, 1000, 1400)).toBeCloseTo(300 / 1400, 10);
  });

  it('floors a landscape page at its width fit', () => {
    expect(minScaleFor(400, 300, 1400, 700)).toBeCloseTo(400 / 1400, 10);
  });

  it('never exceeds fit-to-width, so the floor only ever relaxes the old one', () => {
    const fitWidth = 400 / 1000;
    expect(minScaleFor(400, 300, 1000, 1400)).toBeLessThanOrEqual(fitWidth);
    expect(minScaleFor(400, 300, 1000, 500)).toBeLessThanOrEqual(fitWidth);
  });

  it('guards an unmeasured viewport', () => {
    expect(minScaleFor(0, 0, 1000, 1400)).toBe(1);
    expect(minScaleFor(400, 0, 1000, 1400)).toBe(1);
  });
});

describe('clampOffsets', () => {
  // 400×300 viewport, 1000×1400 page
  const clamp = (scale: number, tx: number, ty: number) => clampOffsets(400, 300, 1000, 1400, scale, tx, ty);

  it('centers each axis where the scaled page fits', () => {
    // scale 0.2 → 200×280 content: fits both axes
    expect(clamp(0.2, -999, 999)).toEqual({ tx: (400 - 200) / 2, ty: (300 - 280) / 2 });
  });

  it('clamps overflowing axes to the content edges', () => {
    // scale 1 → 1000×1400 content overflows both axes: tx ∈ [-600, 0], ty ∈ [-1100, 0]
    expect(clamp(1, 50, 50)).toEqual({ tx: 0, ty: 0 });
    expect(clamp(1, -9999, -9999)).toEqual({ tx: 400 - 1000, ty: 300 - 1400 });
    expect(clamp(1, -300, -700)).toEqual({ tx: -300, ty: -700 }); // in-range passes through
  });

  it('mixes centering and clamping per axis', () => {
    // scale 0.35 → 350×490: width fits (center), height overflows (clamp)
    const r = clamp(0.35, -50, 10);
    expect(r.tx).toBeCloseTo((400 - 350) / 2, 10);
    expect(r.ty).toBe(0);
  });

  it('treats an exact fit as fitting (centered at 0)', () => {
    const r = clampOffsets(400, 300, 800, 600, 0.5, -20, -20);
    expect(r).toEqual({ tx: 0, ty: 0 });
  });
});
