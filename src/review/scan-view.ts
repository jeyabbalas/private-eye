/**
 * The scan viewport: zoom + pan around the confidence overlay. The overlay stack
 * (raster + confidence canvas + hit/ring layers) is laid out at page-pixel size
 * and moved as one unit by a CSS transform — translate + scale, origin top-left —
 * so every layer stays pixel-aligned at any zoom. Hit-testing elsewhere stays
 * ratio-based against the live bounding rect, so the transform is transparent to
 * region-draw and hover linking.
 *
 * Controls: + / − / fit / 100% buttons (driven by the surface), wheel to zoom about
 * the cursor, and drag to pan. "Fit" sizes the page to the viewport width; until
 * the user zooms manually, a resize re-fits.
 */
import type { BBox } from '../core/types.ts';

export interface ScanViewHandle {
  /** The viewport element to place in the scan pane (fills it). */
  readonly el: HTMLElement;
  /** Zoom + center so a page-pixel box fills ~80% of the viewport. */
  zoomToBox(box: BBox): void;
  /** Fit the page to the viewport width (resets pan). */
  fit(): void;
  /** 100% — one page pixel per CSS pixel. */
  actual(): void;
  /** Multiply the current zoom about the viewport center. */
  zoomBy(factor: number): void;
  destroy(): void;
}

export interface ScanViewOptions {
  /** The overlay element (its `.pe-overlay` wrapper). */
  content: HTMLElement;
  /** Page-pixel dimensions of the content. */
  pageWidth: number;
  pageHeight: number;
}

const MAX_SCALE = 8;

/** Pure: the transform that fits a page-pixel box to ~80% of the viewport and
 *  centers it, clamped to [fit-to-width, maxScale]. Exported for testing. */
export function zoomToBoxTransform(
  vw: number,
  vh: number,
  pageW: number,
  pageH: number,
  box: BBox,
  maxScale = MAX_SCALE,
): { scale: number; tx: number; ty: number } {
  const fit = vw > 0 ? vw / pageW : 1; // fit-to-width is the zoom floor
  const bw = Math.max(1, box.x1 - box.x0);
  const bh = Math.max(1, box.y1 - box.y0);
  const scale = Math.min(maxScale, Math.max(fit, 0.8 * Math.min(vw / bw, vh / bh)));
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  return { scale, tx: vw / 2 - cx * scale, ty: vh / 2 - cy * scale };
}

export function createScanView(opts: ScanViewOptions): ScanViewHandle {
  const { content, pageWidth, pageHeight } = opts;

  const el = document.createElement('div');
  el.className = 'pe-scanview';

  // Lay the overlay out at page-pixel size; the transform does all sizing.
  content.style.position = 'absolute';
  content.style.top = '0';
  content.style.left = '0';
  content.style.width = `${pageWidth}px`;
  content.style.height = `${pageHeight}px`;
  content.style.transformOrigin = '0 0';
  el.appendChild(content);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let userZoomed = false;

  const viewport = (): { w: number; h: number } => ({ w: el.clientWidth, h: el.clientHeight });

  const fitScale = (): number => {
    const { w } = viewport();
    return w > 0 ? w / pageWidth : 1;
  };

  const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(fitScale(), s));

  /** Keep the page from drifting fully out of view; center it when smaller. */
  const clampPan = (): void => {
    const { w, h } = viewport();
    const cw = pageWidth * scale;
    const ch = pageHeight * scale;
    tx = cw <= w ? (w - cw) / 2 : Math.min(0, Math.max(w - cw, tx));
    ty = ch <= h ? (h - ch) / 2 : Math.min(0, Math.max(h - ch, ty));
  };

  const apply = (): void => {
    clampPan();
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };

  const fit = (): void => {
    scale = fitScale();
    tx = 0;
    ty = 0;
    apply();
  };

  /** Zoom about a viewport-space point (keeps that page point under the cursor). */
  const zoomAbout = (vx: number, vy: number, nextScale: number): void => {
    const s = clampScale(nextScale);
    if (s === scale) return;
    const px = (vx - tx) / scale;
    const py = (vy - ty) / scale;
    scale = s;
    tx = vx - px * scale;
    ty = vy - py * scale;
    userZoomed = true;
    apply();
  };

  // --- wheel to zoom about the cursor ---
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAbout(e.clientX - r.left, e.clientY - r.top, scale * factor);
    },
    { passive: false },
  );

  // --- drag to pan (ignores the region-draw layer, which sits on top when active) ---
  let panId: number | null = null;
  let panStart = { x: 0, y: 0, tx: 0, ty: 0 };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('.pe-overlay-draw')) return; // mid region-draw
    panId = e.pointerId;
    panStart = { x: e.clientX, y: e.clientY, tx, ty };
    el.classList.add('pe-scanview-panning');
  });
  el.addEventListener('pointermove', (e) => {
    if (panId !== e.pointerId) return;
    if (panId !== null && !el.hasPointerCapture(panId)) {
      // Start capturing only once the drag is genuinely moving (lets clicks through).
      if (Math.abs(e.clientX - panStart.x) + Math.abs(e.clientY - panStart.y) < 3) return;
      el.setPointerCapture(panId);
    }
    tx = panStart.tx + (e.clientX - panStart.x);
    ty = panStart.ty + (e.clientY - panStart.y);
    apply();
  });
  const endPan = (e: PointerEvent): void => {
    if (panId !== e.pointerId) return;
    if (el.hasPointerCapture(panId)) el.releasePointerCapture(panId);
    panId = null;
    el.classList.remove('pe-scanview-panning');
  };
  el.addEventListener('pointerup', endPan);
  el.addEventListener('pointercancel', endPan);

  // --- re-fit on resize until the user takes manual control ---
  const ro = new ResizeObserver(() => {
    if (userZoomed) apply();
    else fit();
  });
  ro.observe(el);

  // Initial fit happens once the element is measured (after it's in the DOM).
  queueMicrotask(fit);

  return {
    el,
    fit() {
      userZoomed = false;
      fit();
    },
    actual() {
      const { w, h } = viewport();
      zoomAbout(w / 2, h / 2, 1);
    },
    zoomBy(factor) {
      const { w, h } = viewport();
      zoomAbout(w / 2, h / 2, scale * factor);
    },
    zoomToBox(box) {
      const { w, h } = viewport();
      const t = zoomToBoxTransform(w, h, pageWidth, pageHeight, box, MAX_SCALE);
      scale = t.scale;
      tx = t.tx;
      ty = t.ty;
      userZoomed = true;
      apply();
    },
    destroy() {
      ro.disconnect();
    },
  };
}
