/**
 * CTC greedy decode (PaddleOCR CTCLabelDecode): argmax per timestep, collapse
 * repeats, drop blank (index 0). Confidence = mean prob of the kept timesteps.
 */

/** Build the full charset: blank + dict entries + space (use_space_char). */
export function buildCharset(dict: string[], withSpace: boolean): string[] {
  const blank = '';
  return [blank, ...dict, ...(withSpace ? [' '] : [])];
}

export interface CtcDecoded {
  text: string;
  conf: number;
  /** Max-softmax of each kept (non-blank, non-repeat) timestep, one per emitted
   *  glyph — aligned to `text` (rec dict glyphs are single chars). */
  charConf: number[];
}

/** probs: one sequence [T x C] row-major, softmaxed. charset[0] is blank. */
export function ctcGreedyDecode(probs: Float32Array, T: number, C: number, charset: string[]): CtcDecoded {
  let prev = -1;
  let text = '';
  let sum = 0;
  let kept = 0;
  const charConf: number[] = [];
  for (let t = 0; t < T; t++) {
    const off = t * C;
    let best = 0;
    let bestP = probs[off]!;
    for (let c = 1; c < C; c++) {
      const v = probs[off + c]!;
      if (v > bestP) {
        bestP = v;
        best = c;
      }
    }
    if (best !== 0 && best !== prev) {
      text += charset[best] ?? '';
      sum += bestP;
      kept++;
      charConf.push(bestP);
    }
    prev = best;
  }
  return { text, conf: kept ? sum / kept : 0, charConf };
}
