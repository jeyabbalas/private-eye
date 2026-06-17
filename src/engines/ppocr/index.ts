/**
 * PP-OCRv5 ONNX runner: DB text detection + CTC recognition, faithful to
 * PaddleOCR's predict_det/predict_rec preprocessing (reference: PaddleOCR
 * python + gutenye/ocr). Browser-portable: all I/O goes through RuntimeContext,
 * all pixel work through src/core/imageops.
 */
import { load } from 'js-yaml';
import { Tensor, type InferenceSession } from 'onnxruntime-common';
import type { BBox, LineConfAgg, OcrLine, OcrResult, OcrWord, Quad, RasterImage } from '../../core/types.ts';
import { quadToBox } from '../../core/types.ts';
import { geoMean, quantile } from '../../core/stats.ts';
import { normalizeToCHW, resizeBilinear, rotate90ccw, warpQuad } from '../../core/imageops.ts';
import type { RuntimeContext } from '../../adapters/types.ts';
import { dbPostprocess } from './db.ts';
import { buildCharset, ctcGreedyDecode } from './ctc.ts';

export interface PpocrOptions {
  det: 'mobile' | 'server';
  detLimit: number; // long-side target for detection input (yml default 960)
  dropScore: number; // drop lines with rec confidence below this (PaddleOCR system default 0.5)
  recBatch: number;
  /** Vertical deflate factor for STRUCTURE geometry. DB unclip=1.5 (needed for
   *  recognition crops) inflates box height ~1.6× the true text line, which
   *  makes adjacent rows overlap and chains them during row-clustering. We keep
   *  the full-width box for crops but compress the reported box height around
   *  its center by this factor so the structure layer sees tight, Tesseract-like
   *  line boxes. x-extent is untouched (bullet/indent detection relies on it). */
  geomDeflateY: number;
}

export const PPOCR_DEFAULTS: PpocrOptions = { det: 'mobile', detLimit: 960, dropScore: 0.5, recBatch: 8, geomDeflateY: 0.6 };

const REC_H = 48;
const REC_BASE_W = 320;
const DET_MEAN: [number, number, number] = [0.485, 0.456, 0.406];
const DET_STD: [number, number, number] = [0.229, 0.224, 0.225];

/** Aggregate per-character confidence into the triage statistics. Geometric mean
 *  (length-normalized sequence prob) for ranking; min/p10 for "worst character". */
function lineConfAgg(charConf: number[]): LineConfAgg {
  return {
    meanLogProb: geoMean(charConf),
    min: charConf.length ? Math.min(...charConf) : 0,
    p10: quantile(charConf, 0.1),
    n: charConf.length,
  };
}

export function detModelSpec(det: 'mobile' | 'server') {
  return { id: `ppocr-det-${det}`, url: `ppocr/det-${det}/inference.onnx` };
}
export const REC_MODEL_SPEC = { id: 'ppocr-rec-en-mobile', url: 'ppocr/rec-en-mobile/inference.onnx' };
const REC_YML = 'ppocr/rec-en-mobile/inference.yml';

export class PpocrEngine {
  readonly id = 'ppocr';
  private det?: InferenceSession;
  private rec?: InferenceSession;
  private charset: string[] = [];
  private opts: PpocrOptions = PPOCR_DEFAULTS;

  async init(ctx: RuntimeContext, opts: Partial<PpocrOptions> = {}): Promise<void> {
    this.opts = { ...PPOCR_DEFAULTS, ...opts };
    const [det, rec, ymlBytes] = await Promise.all([
      ctx.createSession(detModelSpec(this.opts.det)),
      ctx.createSession(REC_MODEL_SPEC),
      ctx.readBytes(ctx.assetUrl(REC_YML)),
    ]);
    this.det = det;
    this.rec = rec;
    const yml = load(new TextDecoder().decode(ymlBytes)) as { PostProcess: { character_dict: string[] } };
    // Output dim C=438 vs 436 dict entries → blank + dict + space (use_space_char).
    this.charset = buildCharset(yml.PostProcess.character_dict, true);
  }

  /** Detect text quads on the full image (original coordinates). */
  private async detect(image: RasterImage): Promise<Quad[]> {
    const det = this.det!;
    const { width: w, height: h } = image;
    const ratio = this.opts.detLimit / Math.max(w, h);
    const round32 = (v: number) => Math.max(32, Math.round(v / 32) * 32);
    const rw = round32(w * ratio);
    const rh = round32(h * ratio);
    const resized = resizeBilinear(image, rw, rh);
    const input = normalizeToCHW(resized, { mean: DET_MEAN, std: DET_STD, scale: 1 / 255, bgr: true });
    const out = await det.run({ [det.inputNames[0]!]: new Tensor('float32', input, [1, 3, rh, rw]) });
    const prob = out[det.outputNames[0]!]!.data as Float32Array;
    return dbPostprocess(prob, rw, rh, w, h).map((b) => b.quad);
  }

  /** Perspective-crop a quad; rotate tall crops upright (PaddleOCR convention). */
  private crop(image: RasterImage, quad: Quad): RasterImage {
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const [tl, tr, br, bl] = quad as [[number, number], [number, number], [number, number], [number, number]];
    const cw = Math.max(1, Math.round(Math.max(dist(tl, tr), dist(bl, br))));
    const ch = Math.max(1, Math.round(Math.max(dist(tl, bl), dist(tr, br))));
    let img = warpQuad(image, quad, cw, ch);
    if (img.height / img.width >= 1.5) img = rotate90ccw(img);
    return img;
  }

  /** Recognize crops in ratio-sorted batches; returns text+conf(+per-char) per crop. */
  private async recognize(crops: RasterImage[]): Promise<{ text: string; conf: number; charConf: number[] }[]> {
    const rec = this.rec!;
    const results = new Array<{ text: string; conf: number; charConf: number[] }>(crops.length);
    const order = crops.map((_, i) => i).sort((a, b) => crops[a]!.width / crops[a]!.height - crops[b]!.width / crops[b]!.height);
    for (let s = 0; s < order.length; s += this.opts.recBatch) {
      const batch = order.slice(s, s + this.opts.recBatch);
      let maxRatio = REC_BASE_W / REC_H;
      for (const i of batch) maxRatio = Math.max(maxRatio, crops[i]!.width / crops[i]!.height);
      // round W up to the model's stride so T = W/8 stays integral
      const imgW = Math.ceil((REC_H * maxRatio) / 8) * 8;
      const data = new Float32Array(batch.length * 3 * REC_H * imgW);
      batch.forEach((cropIdx, bi) => {
        const crop = crops[cropIdx]!;
        const rw = Math.min(imgW, Math.ceil((REC_H * crop.width) / crop.height));
        const resized = resizeBilinear(crop, rw, REC_H);
        const chw = normalizeToCHW(resized, { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], scale: 1 / 255, bgr: true });
        const base = bi * 3 * REC_H * imgW;
        for (let c = 0; c < 3; c++) {
          for (let y = 0; y < REC_H; y++) {
            data.set(chw.subarray((c * REC_H + y) * rw, (c * REC_H + y) * rw + rw), base + (c * REC_H + y) * imgW);
          }
        }
      });
      const out = await rec.run({ [rec.inputNames[0]!]: new Tensor('float32', data, [batch.length, 3, REC_H, imgW]) });
      const t = out[rec.outputNames[0]!]!;
      const [, T, C] = t.dims as [number, number, number];
      const probs = t.data as Float32Array;
      batch.forEach((cropIdx, bi) => {
        results[cropIdx] = ctcGreedyDecode(probs.subarray(bi * T * C, (bi + 1) * T * C), T, C, this.charset);
      });
    }
    return results;
  }

  /** Vertically deflate a box around its center (keep x), to undo DB unclip's
   *  height inflation for layout purposes. */
  private deflate(box: { x0: number; y0: number; x1: number; y1: number }) {
    const k = this.opts.geomDeflateY;
    const cy = (box.y0 + box.y1) / 2;
    const h = (box.y1 - box.y0) * k;
    return { x0: box.x0, x1: box.x1, y0: cy - h / 2, y1: cy + h / 2 };
  }

  /** Split a line's text on spaces into words with x-extents allocated
   *  proportionally to character counts (rec gives no per-char geometry). When
   *  per-char confidence is present it is sliced per word (charConf is aligned to
   *  `text` including the single separating spaces, which are kept timesteps). */
  private synthesizeWords(text: string, box: BBox, conf: number, charConf?: number[]): OcrWord[] {
    const parts = text.split(' ').filter((p) => p.length > 0);
    if (parts.length <= 1) return [{ text, box, conf, charConf }];
    const units = parts.reduce((a, p) => a + p.length, 0) + (parts.length - 1);
    const uw = (box.x1 - box.x0) / units;
    const words: OcrWord[] = [];
    let u = 0; // char cursor (incl. single spaces), used for both x-extent and charConf slicing
    for (const p of parts) {
      words.push({
        text: p,
        box: { x0: box.x0 + u * uw, y0: box.y0, x1: box.x0 + (u + p.length) * uw, y1: box.y1 },
        conf,
        charConf: charConf?.slice(u, u + p.length),
      });
      u += p.length + 1;
    }
    return words;
  }

  async run(image: RasterImage): Promise<{ result: OcrResult; detMs: number; recMs: number }> {
    if (!this.det || !this.rec) throw new Error('PpocrEngine.init not called');
    const t0 = performance.now();
    const quads = await this.detect(image);
    const t1 = performance.now();
    const crops = quads.map((q) => this.crop(image, q));
    const decoded = await this.recognize(crops);
    const t2 = performance.now();

    const lines: OcrLine[] = [];
    for (let i = 0; i < quads.length; i++) {
      const { text, conf, charConf } = decoded[i]!;
      if (!text.trim() || conf < this.opts.dropScore) continue;
      const quad = quads[i]!;
      const box = this.deflate(quadToBox(quad));
      lines.push({ text, box, conf, charConf, confAgg: lineConfAgg(charConf), quad, words: this.synthesizeWords(text, box, conf, charConf) });
    }
    lines.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
    return {
      result: { lines, width: image.width, height: image.height, engineId: this.id },
      detMs: t1 - t0,
      recMs: t2 - t1,
    };
  }

  async dispose(): Promise<void> {
    await this.det?.release();
    await this.rec?.release();
    this.det = this.rec = undefined;
  }
}
