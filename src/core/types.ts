/** Geometry + OCR lingua franca shared by every engine and the structure layer. */

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Four points (clockwise from top-left), as produced by text detectors. */
export type Quad = [number, number][];

/** Decoded image: RGBA, non-premultiplied, row-major. */
export interface RasterImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Statistically-chosen aggregations of a line's per-character confidence. */
export interface LineConfAgg {
  /** Length-normalized geometric mean of charConf (= exp(mean(log p))). */
  meanLogProb: number;
  /** Lowest per-character confidence (the worst character) — drives triage. */
  min: number;
  /** 10th-percentile per-character confidence (robust "worst"). */
  p10: number;
  /** Character count (kept CTC timesteps) contributing to the aggregation. */
  n: number;
}

export interface OcrWord {
  text: string;
  box: BBox;
  conf: number; // 0..1
  /** Per-character confidence aligned to `text`; absent for engines that don't provide it. */
  charConf?: number[];
}

export interface OcrLine {
  text: string;
  box: BBox;
  conf: number; // 0..1 (PP-OCR: arithmetic mean of kept-timestep softmax — unchanged for drop-score parity)
  /** Per-character confidence aligned to `text` (PP-OCR CTC); absent for engines that don't provide it. */
  charConf?: number[];
  /** Aggregations of charConf for the uncertainty layer (geometric mean / min / p10). */
  confAgg?: LineConfAgg;
  words?: OcrWord[];
  quad?: Quad;
}

export interface OcrResult {
  lines: OcrLine[];
  width: number;
  height: number;
  engineId: string;
}

// --- small geometry helpers used across the structure layer ---

export function boxWidth(b: BBox): number {
  return b.x1 - b.x0;
}
export function boxHeight(b: BBox): number {
  return b.y1 - b.y0;
}
export function boxCenterX(b: BBox): number {
  return (b.x0 + b.x1) / 2;
}
export function boxCenterY(b: BBox): number {
  return (b.y0 + b.y1) / 2;
}
export function unionBox(boxes: BBox[]): BBox {
  const b = boxes[0]!;
  let { x0, y0, x1, y1 } = b;
  for (const o of boxes) {
    x0 = Math.min(x0, o.x0);
    y0 = Math.min(y0, o.y0);
    x1 = Math.max(x1, o.x1);
    y1 = Math.max(y1, o.y1);
  }
  return { x0, y0, x1, y1 };
}
/** Fraction of a's height that overlaps b vertically (0..1). */
export function vOverlapRatio(a: BBox, b: BBox): number {
  const top = Math.max(a.y0, b.y0);
  const bot = Math.min(a.y1, b.y1);
  const inter = Math.max(0, bot - top);
  const h = Math.min(boxHeight(a), boxHeight(b));
  return h > 0 ? inter / h : 0;
}
/** Fraction of a's width that overlaps b horizontally (0..1). */
export function hOverlapRatio(a: BBox, b: BBox): number {
  const left = Math.max(a.x0, b.x0);
  const right = Math.min(a.x1, b.x1);
  const inter = Math.max(0, right - left);
  const w = Math.min(boxWidth(a), boxWidth(b));
  return w > 0 ? inter / w : 0;
}
export function quadToBox(q: Quad): BBox {
  const xs = q.map((p) => p[0]);
  const ys = q.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
export function boxArea(b: BBox): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}
export function interArea(a: BBox, b: BBox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}
export function boxIoU(a: BBox, b: BBox): number {
  const i = interArea(a, b);
  const u = boxArea(a) + boxArea(b) - i;
  return u > 0 ? i / u : 0;
}
