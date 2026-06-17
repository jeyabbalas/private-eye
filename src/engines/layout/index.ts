/**
 * PP-DocLayoutV3 ONNX runner: RT-DETR-style layout detection with a learned
 * reading-order head. Preprocess per the official exporter config (800x800,
 * RGB, scale 1/255, mean 0 / std 1); decode mirrors the official HF
 * post_process_object_detection (see postprocess.ts). Browser-portable: all
 * I/O via RuntimeContext, all pixel work via src/core/imageops.
 *
 * Memory note: the model also emits out_masks [1,300,200,200] (~48 MB f32 per
 * page if materialized). We pass an explicit fetches list so it is never
 * fetched and ORT can prune the mask head at run time.
 */
import { load } from 'js-yaml';
import { Tensor, type InferenceSession } from 'onnxruntime-common';
import type { RasterImage } from '../../core/types.ts';
import { normalizeToCHW, resizeBilinear } from '../../core/imageops.ts';
import type { ModelSpec, RuntimeContext } from '../../adapters/types.ts';
import { decodeOrderVotes, decodeRegions, dedupeRegions, type LayoutRegion } from './postprocess.ts';

export type { LayoutRegion } from './postprocess.ts';

// The .patched graph (ceil_mode flip, bit-exact — see scripts/patch/
// layout-maxpool.ts + PROVENANCE.json) serves every EP: node-cpu, wasm, webgpu.
export const LAYOUT_MODEL_SPEC: ModelSpec = {
  id: 'doclayoutv3',
  url: 'layout/doclayoutv3/PP-DocLayoutV3.patched.onnx',
  externalData: ['layout/doclayoutv3/PP-DocLayoutV3.onnx.data'],
};
const LAYOUT_YML = 'layout/doclayoutv3/inference.yml';
const INPUT_SIZE = 800;

export interface LayoutOptions {
  /** Sigmoid score threshold (reference default 0.5). */
  layoutThresh: number;
}
export const LAYOUT_DEFAULTS: LayoutOptions = { layoutThresh: 0.5 };

export interface LayoutResult {
  /** Deduped regions in LEARNED reading order (orderRank ascending). */
  regions: LayoutRegion[];
  width: number;
  height: number;
}

export class LayoutEngine {
  readonly id = 'doclayoutv3';
  private sess?: InferenceSession;
  private labels: string[] = [];
  private opts: LayoutOptions = LAYOUT_DEFAULTS;

  async init(ctx: RuntimeContext, opts: Partial<LayoutOptions> = {}): Promise<void> {
    this.opts = { ...LAYOUT_DEFAULTS, ...opts };
    const [sess, ymlBytes] = await Promise.all([
      ctx.createSession(LAYOUT_MODEL_SPEC),
      ctx.readBytes(ctx.assetUrl(LAYOUT_YML)),
    ]);
    this.sess = sess;
    const yml = load(new TextDecoder().decode(ymlBytes)) as { label_list: string[] };
    this.labels = yml.label_list;
  }

  async run(image: RasterImage): Promise<{ result: LayoutResult; layoutMs: number }> {
    const sess = this.sess;
    if (!sess) throw new Error('LayoutEngine.init not called');
    const t0 = performance.now();
    const resized = resizeBilinear(image, INPUT_SIZE, INPUT_SIZE);
    const chw = normalizeToCHW(resized, { mean: [0, 0, 0], std: [1, 1, 1], scale: 1 / 255, bgr: false });
    const feeds = { pixel_values: new Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]) };
    // Explicit fetches: skip out_masks (48 MB/page) — see module header.
    const out = await sess.run(feeds, ['logits', 'pred_boxes', 'order_logits']);
    const logits = out['logits']!;
    const boxes = out['pred_boxes']!;
    const order = out['order_logits']!;
    const [, q, c] = logits.dims as [number, number, number];
    const votes = decodeOrderVotes(order.data as Float32Array, q);
    const regions = dedupeRegions(
      decodeRegions(
        logits.data as Float32Array,
        boxes.data as Float32Array,
        q,
        c,
        this.labels,
        this.opts.layoutThresh,
        image.width,
        image.height,
        votes,
      ),
    );
    return {
      result: { regions, width: image.width, height: image.height },
      layoutMs: performance.now() - t0,
    };
  }

  async dispose(): Promise<void> {
    await this.sess?.release();
    this.sess = undefined;
  }
}
