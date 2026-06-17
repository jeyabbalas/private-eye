/**
 * SLANet_plus ONNX runner: table-structure recognition on a table-region crop.
 * Preprocess per models/slanet/inference.yml (faithful to PaddleOCR
 * ResizeTableImage / NormalizeImage / PaddingTableImage):
 *   BGR -> longest side resized to 488 (aspect kept, int-truncated) ->
 *   1/255 + ImageNet mean/std -> pad bottom/right with 0.0 AFTER normalize
 *   (PaddingTableImage fills np.zeros) -> CHW [1,3,488,488].
 * Outputs (verified on the shipped ONNX): loc_preds [1,T,8] + structure_probs
 * [1,T,50], identified by trailing dim. Decode in ./decode.ts.
 */
import { load } from 'js-yaml';
import { Tensor, type InferenceSession } from 'onnxruntime-common';
import type { RasterImage } from '../../core/types.ts';
import { normalizeToCHW, resizeBilinear } from '../../core/imageops.ts';
import type { ModelSpec, RuntimeContext } from '../../adapters/types.ts';
import { buildTableVocab, decodeTable, type TableStructure } from './decode.ts';

export type { TableCell, TableStructure } from './decode.ts';

export const SLANET_MODEL_SPEC: ModelSpec = { id: 'slanet-plus', url: 'slanet/inference.onnx' };
const SLANET_YML = 'slanet/inference.yml';
const PAD_SIZE = 488;
const MEAN: [number, number, number] = [0.485, 0.456, 0.406];
const STD: [number, number, number] = [0.229, 0.224, 0.225];

export class SlanetEngine {
  readonly id = 'slanet-plus';
  private sess?: InferenceSession;
  private vocab: string[] = [];

  async init(ctx: RuntimeContext): Promise<void> {
    const [sess, ymlBytes] = await Promise.all([
      ctx.createSession(SLANET_MODEL_SPEC),
      ctx.readBytes(ctx.assetUrl(SLANET_YML)),
    ]);
    this.sess = sess;
    const yml = load(new TextDecoder().decode(ymlBytes)) as {
      PostProcess: { character_dict: string[]; merge_no_span_structure?: boolean };
    };
    this.vocab = buildTableVocab(yml.PostProcess.character_dict, yml.PostProcess.merge_no_span_structure ?? true);
  }

  /** Run on a table-region crop; cell coordinates are in CROP pixels. */
  async run(crop: RasterImage): Promise<{ result: TableStructure; tableMs: number }> {
    const sess = this.sess;
    if (!sess) throw new Error('SlanetEngine.init not called');
    const t0 = performance.now();

    const ratio = PAD_SIZE / Math.max(crop.width, crop.height);
    const rw = Math.max(1, Math.trunc(crop.width * ratio)); // int() truncation, per ResizeTableImage
    const rh = Math.max(1, Math.trunc(crop.height * ratio));
    const resized = resizeBilinear(crop, rw, rh);
    const norm = normalizeToCHW(resized, { mean: MEAN, std: STD, scale: 1 / 255, bgr: true });
    const data = new Float32Array(3 * PAD_SIZE * PAD_SIZE); // zero pad = post-normalize 0.0
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < rh; y++) {
        data.set(norm.subarray((c * rh + y) * rw, (c * rh + y) * rw + rw), (c * PAD_SIZE + y) * PAD_SIZE);
      }
    }

    const feeds = { [sess.inputNames[0]!]: new Tensor('float32', data, [1, 3, PAD_SIZE, PAD_SIZE]) };
    const out = await sess.run(feeds);
    let loc: Tensor | undefined;
    let probs: Tensor | undefined;
    for (const name of sess.outputNames) {
      const t = out[name];
      if (!t) continue;
      const last = t.dims[t.dims.length - 1];
      if (last === 8) loc = t;
      else probs = t;
    }
    if (!loc || !probs) throw new Error(`slanet: unexpected outputs [${sess.outputNames.join(', ')}]`);
    const [, T, V] = probs.dims as [number, number, number];
    const result = decodeTable(
      probs.data as Float32Array,
      loc.data as Float32Array,
      T,
      V,
      this.vocab,
      PAD_SIZE,
      ratio,
    );
    return { result, tableMs: performance.now() - t0 };
  }

  async dispose(): Promise<void> {
    await this.sess?.release();
    this.sess = undefined;
  }
}
