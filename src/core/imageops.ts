/**
 * Pure-TS image operations on RasterImage (RGBA). No canvas, no sharp, no cv —
 * identical results in Node and the browser (bit-parity matters for the
 * Node-vs-browser CER gate in P6).
 */
import type { Quad, RasterImage } from './types.ts';

/** Bilinear resize with cv2-style pixel-center alignment. */
export function resizeBilinear(img: RasterImage, outW: number, outH: number): RasterImage {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = w / outW;
  const sy = h / outH;
  for (let y = 0; y < outH; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), h - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, h - 1);
    const wy = fy - y0;
    for (let x = 0; x < outW; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), w - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, w - 1);
      const wx = fx - x0;
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      const o = (y * outW + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = data[i00 + c]! * (1 - wx) + data[i01 + c]! * wx;
        const bot = data[i10 + c]! * (1 - wx) + data[i11 + c]! * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Solve the 3x3 homography mapping dst rect corners (0,0)(W,0)(W,H)(0,H) → quad. */
function quadHomography(quad: Quad, W: number, H: number): number[] {
  const src: [number, number][] = [
    [0, 0],
    [W, 0],
    [W, H],
    [0, H],
  ];
  // 8 unknowns a..h with x' = (a x + b y + c)/(g x + h y + 1), y' = (d x + e y + f)/(...)
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!;
    const [X, Y] = quad[i]!;
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    b.push(Y);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    [b[col], b[piv]] = [b[piv]!, b[col]!];
    const d = A[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = A[r]![col]! / d;
      for (let c = col; c < n; c++) A[r]![c]! -= f * A[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const sol = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= A[r]![c]! * sol[c]!;
    sol[r] = s / A[r]![r]!;
  }
  return sol; // [a,b,c,d,e,f,g,h]
}

/** Perspective-warp a quad region into an outW×outH RGBA image (bilinear). */
export function warpQuad(img: RasterImage, quad: Quad, outW: number, outH: number): RasterImage {
  const [a, b, c, d, e, f, g, hh] = quadHomography(quad, outW, outH) as [
    number, number, number, number, number, number, number, number,
  ];
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const den = g * x + hh * y + 1;
      const fx = (a * x + b * y + c) / den;
      const fy = (d * x + e * y + f) / den;
      const o = (y * outW + x) * 4;
      if (fx < -1 || fy < -1 || fx > w || fy > h) {
        out[o + 3] = 255;
        continue;
      }
      const cx = Math.min(Math.max(fx, 0), w - 1);
      const cy = Math.min(Math.max(fy, 0), h - 1);
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(x0 + 1, w - 1);
      const y1 = Math.min(y0 + 1, h - 1);
      const wx = cx - x0;
      const wy = cy - y0;
      const i00 = (y0 * w + x0) * 4;
      const i01 = (y0 * w + x1) * 4;
      const i10 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const top = data[i00 + ch]! * (1 - wx) + data[i01 + ch]! * wx;
        const bot = data[i10 + ch]! * (1 - wx) + data[i11 + ch]! * wx;
        out[o + ch] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { data: out, width: outW, height: outH };
}

/** Rotate 90° counter-clockwise (matches np.rot90 used for tall PP-OCR crops). */
export function rotate90ccw(img: RasterImage): RasterImage {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(w * h * 4);
  // out(x', y') = in(x = w-1-y', y = x'), out dims (h, w)
  for (let yp = 0; yp < w; yp++) {
    for (let xp = 0; xp < h; xp++) {
      const i = ((w - 1 - yp) + xp * w) * 4; // in(y=xp, x=w-1-yp)
      const o = (yp * h + xp) * 4;
      out[o] = data[i]!;
      out[o + 1] = data[i + 1]!;
      out[o + 2] = data[i + 2]!;
      out[o + 3] = data[i + 3]!;
    }
  }
  return { data: out, width: h, height: w };
}

export interface NormOpts {
  /** Per-channel mean/std applied after `scale`, in the OUTPUT channel order. */
  mean: [number, number, number];
  std: [number, number, number];
  scale: number; // e.g. 1/255
  /** Emit BGR channel planes (PaddleOCR models are trained on cv2 BGR input). */
  bgr: boolean;
}

/** RGBA → normalized float CHW planes. */
export function normalizeToCHW(img: RasterImage, opts: NormOpts): Float32Array {
  const { data, width: w, height: h } = img;
  const out = new Float32Array(3 * h * w);
  const order = opts.bgr ? [2, 1, 0] : [0, 1, 2]; // RGBA offsets per output channel
  for (let c = 0; c < 3; c++) {
    const off = order[c]!;
    const mean = opts.mean[c]!;
    const std = opts.std[c]!;
    const plane = c * h * w;
    for (let i = 0, n = h * w; i < n; i++) {
      out[plane + i] = (data[i * 4 + off]! * opts.scale - mean) / std;
    }
  }
  return out;
}
