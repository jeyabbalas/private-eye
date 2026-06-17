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

  el.append(image, canvas, hits);

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
    ringEl.style.display = 'block';
    ringEl.style.left = `${(box.x0 / width) * 100}%`;
    ringEl.style.top = `${(box.y0 / height) * 100}%`;
    ringEl.style.width = `${((box.x1 - box.x0) / width) * 100}%`;
    ringEl.style.height = `${((box.y1 - box.y0) / height) * 100}%`;
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
    destroy() {
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
