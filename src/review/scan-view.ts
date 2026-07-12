/**
 * The scan viewport: zoom + pan around the confidence overlay. The overlay stack
 * (raster + confidence canvas + hit/ring layers) is laid out at page-pixel size
 * and moved as one unit by a CSS transform — translate + scale, origin top-left —
 * so every layer stays pixel-aligned at any zoom. Hit-testing elsewhere stays
 * ratio-based against the live bounding rect, so the transform is transparent to
 * region-draw and hover linking.
 *
 * Interaction follows document-viewer convention: wheel pans (Shift+wheel for
 * horizontal on a mouse), Ctrl/⌘+wheel — which is also how a trackpad pinch
 * arrives — zooms about the cursor, drag pans, and the element is focusable so
 * arrow/paging keys can drive it (dispatched by the surface via panBy/panEdge).
 * Thin fading indicator bars mirror the off-screen extent after any movement.
 * "Fit" sizes the page to the viewport width; zooming out can go further, down
 * to the whole page; until the user zooms manually, a resize re-fits.
 */
import type { BBox } from '../core/types.ts';

export interface ScanViewHandle {
  /** The viewport element to place in the scan pane (fills it, focusable). */
  readonly el: HTMLElement;
  /** Zoom + center so a page-pixel box fills ~80% of the viewport. */
  zoomToBox(box: BBox): void;
  /** Fit the page to the viewport width (resets pan). */
  fit(): void;
  /** 100% — one page pixel per CSS pixel. */
  actual(): void;
  /** Multiply the current zoom about the viewport center. */
  zoomBy(factor: number): void;
  /** Scroll the view by (dx, dy) CSS px — positive moves right/down. */
  panBy(dx: number, dy: number): void;
  /** Jump the view to the page's top or bottom edge. */
  panEdge(edge: 'top' | 'bottom'): void;
  destroy(): void;
}

export interface ScanViewOptions {
  /** The overlay element (its `.pe-overlay` wrapper). */
  content: HTMLElement;
  /** Page-pixel dimensions of the content. */
  pageWidth: number;
  pageHeight: number;
  /** Fired after every transform change (feeds the live zoom label). */
  onTransform?: (scale: number, fitScale: number) => void;
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

/** Pure: normalize a wheel event's deltas to CSS pixels across delta modes
 *  (0 = pixel, 1 = line — Firefox mice, 2 = page). Exported for testing. */
export function normalizeWheel(dx: number, dy: number, deltaMode: number): { dx: number; dy: number } {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? 120 : 1;
  return { dx: dx * k, dy: dy * k };
}

/** Pure: map a normalized wheel delta to a pan step. Shift redirects a
 *  vertical-only gesture (a mouse wheel) onto the horizontal axis; a trackpad's
 *  genuine two-axis gesture (dx ≠ 0) is left untouched. Exported for testing. */
export function wheelPanDelta(dx: number, dy: number, shift: boolean): { dx: number; dy: number } {
  if (shift && dx === 0) return { dx: dy, dy: 0 };
  return { dx, dy };
}

/** Pure: smooth zoom factor for a normalized wheel delta — exponential so pinch
 *  feels linear, clamped to ±32px per event so a mouse notch (~100px) lands at
 *  a controlled ~25-30% step. Exported for testing. */
export function wheelZoomFactor(dyNorm: number): number {
  const d = Math.min(32, Math.max(-32, dyNorm));
  return Math.exp(-d * 0.008);
}

/** Pure: the zoom-out floor — the scale at which the whole page fits in the
 *  viewport (both dimensions). Exported for testing. */
export function minScaleFor(vw: number, vh: number, pageW: number, pageH: number): number {
  if (vw <= 0 || vh <= 0) return 1;
  return Math.min(vw / pageW, vh / pageH);
}

/** Pure: keep the page from drifting fully out of view — clamp the translation
 *  when the scaled page overflows the viewport, center it when it fits.
 *  Exported for testing. */
export function clampOffsets(
  vw: number,
  vh: number,
  pageW: number,
  pageH: number,
  scale: number,
  tx: number,
  ty: number,
): { tx: number; ty: number } {
  const cw = pageW * scale;
  const ch = pageH * scale;
  return {
    tx: cw <= vw ? (vw - cw) / 2 : Math.min(0, Math.max(vw - cw, tx)),
    ty: ch <= vh ? (vh - ch) / 2 : Math.min(0, Math.max(vh - ch, ty)),
  };
}

/** Pure: geometry for a thin scroll-indicator thumb along one axis. Null when
 *  the content fits (no bar); otherwise thumb length (min 24px) and offset in
 *  track px for a track the size of the viewport. Exported for testing. */
export function scrollbarMetrics(
  viewportPx: number,
  contentPx: number,
  offsetPx: number,
  minThumb = 24,
): { size: number; pos: number } | null {
  if (viewportPx <= 0 || contentPx <= viewportPx) return null;
  const size = Math.min(viewportPx, Math.max(minThumb, (viewportPx / contentPx) * viewportPx));
  const travel = viewportPx - size;
  const frac = Math.min(1, Math.max(0, offsetPx / (contentPx - viewportPx)));
  return { size, pos: travel * frac };
}

export function createScanView(opts: ScanViewOptions): ScanViewHandle {
  const { content, pageWidth, pageHeight } = opts;

  const el = document.createElement('div');
  el.className = 'pe-scanview';
  el.tabIndex = 0;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Scanned page. Scroll or arrow keys pan; Ctrl or ⌘ with scroll, or plus and minus, zoom.');

  // Lay the overlay out at page-pixel size; the transform does all sizing.
  content.style.position = 'absolute';
  content.style.top = '0';
  content.style.left = '0';
  content.style.width = `${pageWidth}px`;
  content.style.height = `${pageHeight}px`;
  content.style.transformOrigin = '0 0';
  el.appendChild(content);

  // Fading scroll indicators (visual only — never interactive).
  const barV = document.createElement('div');
  barV.className = 'pe-scanbar pe-scanbar-v';
  barV.setAttribute('aria-hidden', 'true');
  const thumbV = document.createElement('div');
  thumbV.className = 'pe-scanbar-thumb';
  barV.appendChild(thumbV);
  const barH = document.createElement('div');
  barH.className = 'pe-scanbar pe-scanbar-h';
  barH.setAttribute('aria-hidden', 'true');
  const thumbH = document.createElement('div');
  thumbH.className = 'pe-scanbar-thumb';
  barH.appendChild(thumbH);
  el.append(barV, barH);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let userZoomed = false;
  let barsTimer: number | null = null;

  const viewport = (): { w: number; h: number } => ({ w: el.clientWidth, h: el.clientHeight });

  const fitScale = (): number => {
    const { w } = viewport();
    return w > 0 ? w / pageWidth : 1;
  };

  // The zoom-out floor is the whole page in view (≤ fit-to-width), so a portrait
  // page can be stepped back to a full, centered overview.
  const clampScale = (s: number): number => {
    const { w, h } = viewport();
    return Math.min(MAX_SCALE, Math.max(Math.min(fitScale(), minScaleFor(w, h, pageWidth, pageHeight)), s));
  };

  const updateBars = (): void => {
    const { w, h } = viewport();
    const v = scrollbarMetrics(h, pageHeight * scale, -ty);
    barV.style.display = v ? 'block' : 'none';
    if (v) {
      thumbV.style.height = `${v.size}px`;
      thumbV.style.transform = `translateY(${v.pos}px)`;
    }
    const hm = scrollbarMetrics(w, pageWidth * scale, -tx);
    barH.style.display = hm ? 'block' : 'none';
    if (hm) {
      thumbH.style.width = `${hm.size}px`;
      thumbH.style.transform = `translateX(${hm.pos}px)`;
    }
  };

  /** Reveal the indicator bars, then let them fade 700ms after the last move. */
  const showBars = (): void => {
    el.classList.add('pe-scanbars-on');
    if (barsTimer != null) clearTimeout(barsTimer);
    barsTimer = window.setTimeout(() => {
      el.classList.remove('pe-scanbars-on');
      barsTimer = null;
    }, 700);
  };

  const apply = (): void => {
    const { w, h } = viewport();
    ({ tx, ty } = clampOffsets(w, h, pageWidth, pageHeight, scale, tx, ty));
    content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    updateBars();
    opts.onTransform?.(scale, fitScale());
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
    showBars();
  };

  /** True while a region-draw rubber band is actively being dragged (the wheel
   *  goes inert then, so the box under the pointer can't slide away). */
  const rubberBandLive = (): boolean => {
    const rect = el.querySelector<HTMLElement>('.pe-draw-rect');
    return !!rect && rect.style.display !== 'none';
  };

  // --- wheel: pan by convention; Ctrl/⌘ (incl. trackpad pinch) zooms about the cursor ---
  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      if (rubberBandLive()) return;
      const norm = normalizeWheel(e.deltaX, e.deltaY, e.deltaMode);
      if (e.ctrlKey || e.metaKey) {
        const r = el.getBoundingClientRect();
        zoomAbout(e.clientX - r.left, e.clientY - r.top, scale * wheelZoomFactor(norm.dy));
      } else {
        const d = wheelPanDelta(norm.dx, norm.dy, e.shiftKey);
        tx -= d.dx;
        ty -= d.dy;
        // Like drag-pan, wheel-pan is not a zoom choice: leave userZoomed alone
        // so a resize keeps re-fitting until the user actually zooms.
        apply();
        showBars();
      }
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
    showBars();
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

  // Initial fit happens once the element is measured (after it's in the DOM);
  // flash the indicators once so the scrollable extent is discoverable.
  queueMicrotask(() => {
    fit();
    showBars();
  });

  return {
    el,
    fit() {
      userZoomed = false;
      fit();
      showBars();
    },
    actual() {
      const { w, h } = viewport();
      zoomAbout(w / 2, h / 2, 1);
    },
    zoomBy(factor) {
      const { w, h } = viewport();
      zoomAbout(w / 2, h / 2, scale * factor);
    },
    panBy(dx, dy) {
      tx -= dx;
      ty -= dy;
      apply();
      showBars();
    },
    panEdge(edge) {
      const { h } = viewport();
      ty = edge === 'top' ? 0 : h - pageHeight * scale;
      apply();
      showBars();
    },
    zoomToBox(box) {
      const { w, h } = viewport();
      const t = zoomToBoxTransform(w, h, pageWidth, pageHeight, box, MAX_SCALE);
      scale = t.scale;
      tx = t.tx;
      ty = t.ty;
      userZoomed = true;
      apply();
      showBars();
    },
    destroy() {
      ro.disconnect();
      if (barsTimer != null) clearTimeout(barsTimer);
    },
  };
}
