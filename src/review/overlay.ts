/**
 * The confidence overlay: the page raster with uncertainty painted on top.
 *
 * Three stacked layers in one wrapper, all in PAGE-PIXEL space and scaled to fit
 * by CSS (so boxes stay aligned at any width / zoom):
 *   1. the raster `<img>` — drawn by the browser, never repainted by us;
 *   2. a `<canvas>` of confidence fills — repainted (rAF-coalesced) only when τ
 *      changes, never re-blitting the raster;
 *   3. a thin DOM hit layer — focus/hover rings and any conflict badges.
 *
 * Fills are thresholded by τ: a character (Quick Read has per-character boxes) or
 * a whole line (Deep Read, no per-char data) is shaded only when its confidence
 * is below τ, colored by band (low = red-ish, worth-a-look = amber). Coverage
 * gaps are always outlined (dashed) — they're "possible missed area", not a
 * confidence reading.
 */
import type { BBox } from '../core/types.ts';
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import { BAND_ALPHA, confidenceBand } from './labels.ts';

export interface OverlayHandle {
  readonly el: HTMLElement;
  /** Re-threshold the fills (rAF-coalesced). */
  setTau(tau: number): void;
  /** Move/show the focus ring and scroll it into view; null hides it. */
  focus(box: BBox | null): void;
  /** Move/show the lighter hover ring; null hides it. */
  hover(box: BBox | null): void;
  /** Enter region-draw mode: rubber-band a rectangle and report it in page-pixel
   *  coordinates (null if cancelled or too small to be intentional). */
  beginDraw(onBox: (box: BBox | null) => void): void;
  /** Leave region-draw mode without reporting a box. */
  cancelDraw(): void;
  destroy(): void;
}

export interface OverlayOptions {
  /** A loaded raster image at (width × height) page pixels. */
  image: HTMLImageElement;
  width: number;
  height: number;
  layer: UncertaintyLayer | undefined;
  tau: number;
}

export function createOverlay(opts: OverlayOptions): OverlayHandle {
  const { image, width, height, layer } = opts;

  const el = document.createElement('div');
  el.className = 'pe-overlay';

  image.classList.add('pe-overlay-img');
  image.draggable = false;

  const canvas = document.createElement('canvas');
  canvas.className = 'pe-overlay-fills';
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));

  const hits = document.createElement('div');
  hits.className = 'pe-overlay-hits';
  const hoverRing = ring('pe-ring-hover');
  const focusRing = ring('pe-ring-focus');
  hits.append(hoverRing, focusRing);

  // Region-draw capture layer (inactive until beginDraw).
  const draw = document.createElement('div');
  draw.className = 'pe-overlay-draw';
  draw.style.display = 'none';
  const drawRect = ring('pe-draw-rect');
  draw.appendChild(drawRect);

  el.append(image, canvas, hits, draw);

  const ctx = canvas.getContext('2d');
  const fill = resolveFills();

  let tau = opts.tau;
  let raf = 0;
  const paint = (): void => {
    raf = 0;
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!layer) return;
    for (const line of layer.lines) {
      if (line.chars.length) {
        for (const c of line.chars) {
          const band = confidenceBand(c.conf);
          if (band === 'ok' || c.conf >= tau) continue;
          ctx.fillStyle = fill[band];
          rect(ctx, c.box);
        }
      } else {
        const band = confidenceBand(line.p10);
        if (band === 'ok' || line.p10 >= tau) continue;
        ctx.fillStyle = fill[band];
        rect(ctx, line.box);
      }
    }
    // Coverage gaps: always outlined, independent of τ.
    if (layer.coverageGaps.length) {
      ctx.save();
      ctx.setLineDash([7, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = fill.gapStroke;
      for (const g of layer.coverageGaps) stroke(ctx, g.box);
      ctx.restore();
    }
  };
  paint();

  const place = (ringEl: HTMLElement, box: BBox | null): void => {
    if (!box) {
      ringEl.style.display = 'none';
      return;
    }
    placePx(ringEl, box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  };
  const placePx = (ringEl: HTMLElement, x: number, y: number, w: number, h: number): void => {
    ringEl.style.display = 'block';
    ringEl.style.left = `${(x / width) * 100}%`;
    ringEl.style.top = `${(y / height) * 100}%`;
    ringEl.style.width = `${(w / width) * 100}%`;
    ringEl.style.height = `${(h / height) * 100}%`;
  };

  // Region-draw state: cleanup for the active drag, if any.
  let cancelActiveDraw: (() => void) | null = null;
  const clampX = (v: number): number => Math.min(width, Math.max(0, v));
  const clampY = (v: number): number => Math.min(height, Math.max(0, v));
  const toPage = (e: PointerEvent): { x: number; y: number } => {
    const r = draw.getBoundingClientRect();
    return {
      x: clampX(((e.clientX - r.left) / r.width) * width),
      y: clampY(((e.clientY - r.top) / r.height) * height),
    };
  };

  return {
    el,
    setTau(next) {
      if (next === tau) return;
      tau = next;
      if (!raf) raf = requestAnimationFrame(paint);
    },
    focus(box) {
      place(focusRing, box);
      if (box) focusRing.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    hover(box) {
      place(hoverRing, box);
    },
    beginDraw(onBox) {
      cancelActiveDraw?.();
      draw.style.display = 'block';
      let start: { x: number; y: number } | null = null;

      const onDown = (e: PointerEvent): void => {
        e.preventDefault();
        start = toPage(e);
        draw.setPointerCapture(e.pointerId);
        placePx(drawRect, start.x, start.y, 0, 0);
      };
      const onMove = (e: PointerEvent): void => {
        if (!start) return;
        const p = toPage(e);
        placePx(drawRect, Math.min(start.x, p.x), Math.min(start.y, p.y), Math.abs(p.x - start.x), Math.abs(p.y - start.y));
      };
      const onUp = (e: PointerEvent): void => {
        if (!start) return;
        const p = toPage(e);
        const box: BBox = {
          x0: Math.min(start.x, p.x),
          y0: Math.min(start.y, p.y),
          x1: Math.max(start.x, p.x),
          y1: Math.max(start.y, p.y),
        };
        finish(box.x1 - box.x0 > 6 && box.y1 - box.y0 > 6 ? box : null);
      };
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') finish(null);
      };
      const finish = (box: BBox | null): void => {
        cleanup();
        onBox(box);
      };
      const cleanup = (): void => {
        draw.removeEventListener('pointerdown', onDown);
        draw.removeEventListener('pointermove', onMove);
        draw.removeEventListener('pointerup', onUp);
        window.removeEventListener('keydown', onKey);
        draw.style.display = 'none';
        drawRect.style.display = 'none';
        start = null;
        cancelActiveDraw = null;
      };

      draw.addEventListener('pointerdown', onDown);
      draw.addEventListener('pointermove', onMove);
      draw.addEventListener('pointerup', onUp);
      window.addEventListener('keydown', onKey);
      cancelActiveDraw = cleanup;
    },
    cancelDraw() {
      cancelActiveDraw?.();
    },
    destroy() {
      cancelActiveDraw?.();
      if (raf) cancelAnimationFrame(raf);
      el.remove();
    },
  };
}

function ring(cls: string): HTMLElement {
  const r = document.createElement('div');
  r.className = `pe-ring ${cls}`;
  r.style.display = 'none';
  return r;
}

function rect(ctx: CanvasRenderingContext2D, b: BBox): void {
  ctx.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
}

function stroke(ctx: CanvasRenderingContext2D, b: BBox): void {
  ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
}

interface Fills {
  low: string;
  caution: string;
  ok: string;
  gapStroke: string;
}

/** Resolve the band CSS custom properties to concrete rgba() fills once. */
function resolveFills(): Fills {
  const cs = getComputedStyle(document.documentElement);
  const rgb = (name: string, fallback: [number, number, number]): [number, number, number] => {
    const m = /#?([0-9a-f]{6})/i.exec(cs.getPropertyValue(name).trim());
    if (!m) return fallback;
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const attention = rgb('--attention', [179, 38, 30]);
  const caution = rgb('--caution', [154, 106, 0]);
  return {
    low: `rgba(${attention.join(',')},${BAND_ALPHA.low})`,
    caution: `rgba(${caution.join(',')},${BAND_ALPHA.caution})`,
    ok: 'rgba(0,0,0,0)',
    gapStroke: `rgba(${attention.join(',')},0.85)`,
  };
}
