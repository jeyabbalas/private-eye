/**
 * DB (Differentiable Binarization) detection postprocess, ported from
 * PaddleOCR's DBPostProcess (box_type='quad', score_mode='fast'). Pure TS:
 * connected components → convex hull → min-area rect → polygon score →
 * unclip (rect expansion; exact for rotated rects) → scale to original image.
 */
import type { Quad } from '../../core/types.ts';

export interface DbParams {
  thresh: number; // binarization threshold (yml: 0.3)
  boxThresh: number; // mean-prob-inside-box threshold (yml: 0.6)
  unclipRatio: number; // yml: 1.5 — recovers the true text box from the shrunk DB kernel
  minSize: number; // min rect side in map px (PaddleOCR default 3)
  maxCandidates: number; // yml: 1000
}

export const DB_DEFAULTS: DbParams = { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, minSize: 3, maxCandidates: 1000 };

export interface DbBox {
  quad: Quad; // [tl, tr, br, bl] in ORIGINAL image coords
  score: number;
}

interface Rect {
  cx: number;
  cy: number;
  ux: number; // unit axis u
  uy: number;
  w: number; // extent along u
  h: number; // extent along v (normal of u)
}

/** Convex hull (Andrew monotone chain). Points need not be unique. */
function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 2) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Min-area rect via rotating calipers over hull edges. */
function minAreaRect(hull: [number, number][]): Rect {
  if (hull.length === 1) {
    const [x, y] = hull[0]!;
    return { cx: x, cy: y, ux: 1, uy: 0, w: 0, h: 0 };
  }
  if (hull.length === 2) {
    const [a, b] = [hull[0]!, hull[1]!];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    return { cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2, ux: dx / len, uy: dy / len, w: len, h: 0 };
  }
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len;
    const uy = dy / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = {
        cx: cu * ux - cv * uy,
        cy: cu * uy + cv * ux,
        ux,
        uy,
        w: maxU - minU,
        h: maxV - minV,
      };
    }
  }
  return best!;
}

function rectCorners(r: Rect): [number, number][] {
  const vx = -r.uy;
  const vy = r.ux;
  const hw = r.w / 2;
  const hh = r.h / 2;
  return [
    [r.cx - r.ux * hw - vx * hh, r.cy - r.uy * hw - vy * hh],
    [r.cx + r.ux * hw - vx * hh, r.cy + r.uy * hw - vy * hh],
    [r.cx + r.ux * hw + vx * hh, r.cy + r.uy * hw + vy * hh],
    [r.cx - r.ux * hw + vx * hh, r.cy - r.uy * hw + vy * hh],
  ];
}

/** Order 4 corners [tl, tr, br, bl], replicating PaddleOCR get_mini_boxes. */
function orderCorners(pts: [number, number][]): Quad {
  const p = [...pts].sort((a, b) => a[0] - b[0]);
  const [i1, i4] = p[1]![1] > p[0]![1] ? [0, 1] : [1, 0];
  const [i2, i3] = p[3]![1] > p[2]![1] ? [2, 3] : [3, 2];
  return [p[i1]!, p[i2]!, p[i3]!, p[i4]!];
}

/** Mean probability inside a convex quad (PaddleOCR box_score_fast). */
function quadMeanScore(prob: Float32Array, w: number, h: number, quad: [number, number][]): number {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      // convex point-in-polygon: consistent cross-product sign over edges
      let pos = false, neg = false;
      for (let i = 0; i < 4; i++) {
        const a = quad[i]!;
        const b = quad[(i + 1) % 4]!;
        const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (c > 0) pos = true;
        else if (c < 0) neg = true;
      }
      if (pos && neg) continue;
      sum += prob[y * w + x]!;
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * prob: detection probability map [mapH x mapW] row-major.
 * Returns text quads scaled to the original image size.
 */
export function dbPostprocess(
  prob: Float32Array,
  mapW: number,
  mapH: number,
  origW: number,
  origH: number,
  params: Partial<DbParams> = {},
): DbBox[] {
  const p = { ...DB_DEFAULTS, ...params };
  const n = mapW * mapH;
  const fg = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (prob[i]! > p.thresh) fg[i] = 1;

  const visited = new Uint8Array(n);
  const boxes: DbBox[] = [];
  const stack: number[] = [];

  for (let start = 0; start < n && boxes.length < p.maxCandidates; start++) {
    if (!fg[start] || visited[start]) continue;
    // flood fill (8-connectivity), tracking per-row x extents for the hull
    visited[start] = 1;
    stack.length = 0;
    stack.push(start);
    const rowMin = new Map<number, number>();
    const rowMax = new Map<number, number>();
    let pixels = 0;
    while (stack.length) {
      const idx = stack.pop()!;
      const y = (idx / mapW) | 0;
      const x = idx - y * mapW;
      pixels++;
      const mn = rowMin.get(y);
      if (mn === undefined || x < mn) rowMin.set(y, x);
      const mx = rowMax.get(y);
      if (mx === undefined || x > mx) rowMax.set(y, x);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= mapH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= mapW) continue;
          const ni = ny * mapW + nx;
          if (fg[ni] && !visited[ni]) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }
    if (pixels < 3) continue;

    const pts: [number, number][] = [];
    for (const [y, x] of rowMin) pts.push([x, y]);
    for (const [y, x] of rowMax) pts.push([x, y]);
    const rect = minAreaRect(convexHull(pts));
    if (Math.min(rect.w, rect.h) < p.minSize) continue;

    const score = quadMeanScore(prob, mapW, mapH, rectCorners(rect));
    if (score < p.boxThresh) continue;

    // unclip: offset the rect outward by delta = area * ratio / perimeter
    // (pyclipper round-join offset of a rectangle + minAreaRect == rect grown
    // by delta on each side, so this is exact for quads)
    const area = rect.w * rect.h;
    const perimeter = 2 * (rect.w + rect.h);
    if (perimeter < 1e-9) continue;
    const delta = (area * p.unclipRatio) / perimeter;
    const grown: Rect = { ...rect, w: rect.w + 2 * delta, h: rect.h + 2 * delta };
    if (Math.min(grown.w, grown.h) < p.minSize + 2) continue;
    const quad = orderCorners(rectCorners(grown)).map(([x, y]) => [
      Math.min(Math.max(Math.round((x / mapW) * origW), 0), origW),
      Math.min(Math.max(Math.round((y / mapH) * origH), 0), origH),
    ]) as Quad;
    boxes.push({ quad, score });
  }
  // stable top-to-bottom, left-to-right order for debuggability
  return boxes.sort((a, b) => a.quad[0]![1] - b.quad[0]![1] || a.quad[0]![0] - b.quad[0]![0]);
}
