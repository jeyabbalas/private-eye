/**
 * Wheel + scroll-indicator math (scan-view.ts). Pins the conventions the scan
 * viewport lives by: wheel deltas normalize to px across delta modes, plain
 * wheel pans (Shift redirects a mouse's vertical gesture horizontally, but
 * never mangles a real two-axis trackpad gesture), Ctrl/⌘-wheel zooms smoothly
 * with a clamped per-event step, and the fading indicator thumbs mirror the
 * off-screen extent.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeWheel,
  scrollbarMetrics,
  wheelPanDelta,
  wheelZoomFactor,
} from '../src/review/scan-view.ts';

describe('normalizeWheel', () => {
  it('passes pixel-mode deltas through unchanged', () => {
    expect(normalizeWheel(4, -12, 0)).toEqual({ dx: 4, dy: -12 });
  });

  it('scales line mode (Firefox mice) to ~16px per line', () => {
    expect(normalizeWheel(0, 3, 1)).toEqual({ dx: 0, dy: 48 });
    expect(normalizeWheel(-2, 0, 1)).toEqual({ dx: -32, dy: 0 });
  });

  it('scales page mode to a viewport-ish step', () => {
    expect(normalizeWheel(0, 1, 2)).toEqual({ dx: 0, dy: 120 });
  });
});

describe('wheelPanDelta', () => {
  it('passes deltas through without shift', () => {
    expect(wheelPanDelta(5, 40, false)).toEqual({ dx: 5, dy: 40 });
  });

  it('shift redirects a vertical-only (mouse) gesture onto the horizontal axis', () => {
    expect(wheelPanDelta(0, 40, true)).toEqual({ dx: 40, dy: 0 });
    expect(wheelPanDelta(0, -40, true)).toEqual({ dx: -40, dy: 0 });
  });

  it('shift leaves a genuine two-axis (trackpad) gesture untouched', () => {
    expect(wheelPanDelta(12, 30, true)).toEqual({ dx: 12, dy: 30 });
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in for wheel-up (negative dy) and out for wheel-down', () => {
    expect(wheelZoomFactor(-10)).toBeGreaterThan(1);
    expect(wheelZoomFactor(10)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('is symmetric: equal and opposite deltas cancel', () => {
    expect(wheelZoomFactor(20) * wheelZoomFactor(-20)).toBeCloseTo(1, 10);
  });

  it('clamps the per-event step, so a mouse notch and a fast fling zoom alike', () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(wheelZoomFactor(-32), 10);
    expect(wheelZoomFactor(500)).toBeCloseTo(wheelZoomFactor(32), 10);
    // ~29% per clamped step keeps a notch meaningful but controlled
    expect(wheelZoomFactor(-32)).toBeCloseTo(Math.exp(32 * 0.008), 10);
  });
});

describe('scrollbarMetrics', () => {
  it('returns null when the content fits (no bar to show)', () => {
    expect(scrollbarMetrics(400, 400, 0)).toBeNull();
    expect(scrollbarMetrics(400, 250, 0)).toBeNull();
  });

  it('returns null for an unmeasured viewport', () => {
    expect(scrollbarMetrics(0, 800, 0)).toBeNull();
  });

  it('sizes the thumb proportionally to the visible fraction', () => {
    const m = scrollbarMetrics(400, 800, 0)!;
    expect(m.size).toBeCloseTo(200, 5); // half visible → half-length thumb
    expect(m.pos).toBe(0);
  });

  it('enforces a minimum thumb length for very long content', () => {
    const m = scrollbarMetrics(400, 100000, 0)!;
    expect(m.size).toBe(24);
  });

  it('maps the scrolled fraction onto the thumb travel', () => {
    const atEnd = scrollbarMetrics(400, 800, 400)!;
    expect(atEnd.pos).toBeCloseTo(400 - atEnd.size, 5);
    const mid = scrollbarMetrics(400, 800, 200)!;
    expect(mid.pos).toBeCloseTo((400 - mid.size) / 2, 5);
  });

  it('clamps out-of-range offsets (mid-clamp overshoot) into the track', () => {
    const under = scrollbarMetrics(400, 800, -50)!;
    expect(under.pos).toBe(0);
    const over = scrollbarMetrics(400, 800, 4000)!;
    expect(over.pos).toBeCloseTo(400 - over.size, 5);
  });
});
