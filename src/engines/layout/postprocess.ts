/**
 * Pure decode for PP-DocLayoutV3 outputs, mirroring the official reference
 * (transformers >= 5.4, PPDocLayoutV3ImageProcessor.post_process_object_detection):
 *   - class scores = sigmoid(logits); keep queries whose best class >= threshold
 *     (reference default 0.5)
 *   - boxes: normalized (cx,cy,w,h) -> corner BBox scaled to the original page
 *   - reading order: votes over the FULL Q x Q order_logits matrix, computed
 *     BEFORE any filtering (the reference calls _get_order_seqs on all queries):
 *       votes[j] = sum_{i<j} sigmoid(L[i,j]) + sum_{i>j} (1 - sigmoid(L[j,i]))
 *     Only the strict upper triangle carries P(col after row); regions sort by
 *     ascending votes (= expected number of elements that precede them).
 *
 * Deviation from the reference: we keep at most one (best-scoring) class per
 * query instead of flattened top-k over all (query,class) pairs, and then
 * geometrically dedupe near-duplicate / nested regions. The layout model is
 * known (P4) to emit text fragments overlapping their containing table region;
 * line->region assignment needs each page area owned by one region.
 */
import type { BBox } from '../../core/types.ts';
import { boxArea, boxIoU, interArea } from '../../core/types.ts';

export interface LayoutRegion {
  /** Raw class name from inference.yml label_list (25 classes). */
  label: string;
  score: number;
  /** Original page pixels, clamped to the page. */
  box: BBox;
  /** DETR query index 0..Q-1 (indexes order_logits). */
  queryIndex: number;
  /** Learned reading-order rank among kept regions (0 = first). */
  orderRank: number;
}

const sigmoid = (v: number): number => 1 / (1 + Math.exp(-v));

/** Reference _get_order_seqs vote computation over the full Q x Q matrix. */
export function decodeOrderVotes(orderLogits: Float32Array, q: number): Float64Array {
  const votes = new Float64Array(q);
  for (let i = 0; i < q; i++) {
    for (let j = i + 1; j < q; j++) {
      const s = sigmoid(orderLogits[i * q + j]!);
      votes[j]! += s; // i precedes j with prob s
      votes[i]! += 1 - s; // j precedes i with prob 1-s
    }
  }
  return votes;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/** Decode kept regions (sigmoid best-class >= threshold), sorted by learned
 *  reading order (ascending order votes, stable by query index). */
export function decodeRegions(
  logits: Float32Array,
  boxes: Float32Array,
  q: number,
  c: number,
  labels: string[],
  scoreThresh: number,
  imgW: number,
  imgH: number,
  orderVotes: Float64Array,
): LayoutRegion[] {
  const kept: LayoutRegion[] = [];
  const nClasses = Math.min(c, labels.length);
  for (let qi = 0; qi < q; qi++) {
    let best = -1;
    let bestLogit = -Infinity;
    for (let ci = 0; ci < nClasses; ci++) {
      const v = logits[qi * c + ci]!;
      if (v > bestLogit) {
        bestLogit = v;
        best = ci;
      }
    }
    const score = sigmoid(bestLogit);
    if (best < 0 || score < scoreThresh) continue;
    const bo = qi * 4;
    const cx = boxes[bo]!;
    const cy = boxes[bo + 1]!;
    const w = boxes[bo + 2]!;
    const h = boxes[bo + 3]!;
    const box: BBox = {
      x0: clamp((cx - w / 2) * imgW, 0, imgW),
      y0: clamp((cy - h / 2) * imgH, 0, imgH),
      x1: clamp((cx + w / 2) * imgW, 0, imgW),
      y1: clamp((cy + h / 2) * imgH, 0, imgH),
    };
    if (box.x1 - box.x0 < 2 || box.y1 - box.y0 < 2) continue;
    kept.push({ label: labels[best]!, score, box, queryIndex: qi, orderRank: 0 });
  }
  kept.sort((a, b) => orderVotes[a.queryIndex]! - orderVotes[b.queryIndex]! || a.queryIndex - b.queryIndex);
  kept.forEach((r, i) => (r.orderRank = i));
  return kept;
}

/** Labels whose regions carry running text (vs. graphics/containers). */
export const TEXT_LIKE = new Set([
  'abstract', 'algorithm', 'aside_text', 'content', 'display_formula', 'doc_title',
  'figure_title', 'footer', 'footnote', 'formula_number', 'header', 'inline_formula',
  'number', 'paragraph_title', 'reference', 'reference_content', 'text',
  'vertical_text', 'vision_footnote',
]);
/** Container regions that legitimately enclose smaller text fragments. */
const CONTAINER = new Set(['table', 'image', 'chart', 'seal']);
export const IMAGE_LIKE = new Set(['image', 'seal', 'chart', 'header_image', 'footer_image']);

/**
 * Geometric dedupe (DETR needs no classic NMS, but near-duplicates and
 * text-inside-container nesting occur). Score-descending sweep:
 *  (a) same label, IoU > 0.6           -> drop the lower-scoring one
 *  (b) text-like fragment >= 80% inside a higher-scoring container -> drop it
 *  (c) different labels, IoU > 0.7 (neither image-like) -> drop lower score
 * Input must be orderRank-sorted; output preserves that order.
 */
export function dedupeRegions(regions: LayoutRegion[]): LayoutRegion[] {
  const byScore = [...regions].sort((a, b) => b.score - a.score);
  const dropped = new Set<LayoutRegion>();
  for (let i = 0; i < byScore.length; i++) {
    const r = byScore[i]!;
    if (dropped.has(r)) continue;
    for (let j = i + 1; j < byScore.length; j++) {
      const s = byScore[j]!;
      if (dropped.has(s)) continue;
      const iou = boxIoU(r.box, s.box);
      if (s.label === r.label && iou > 0.6) {
        dropped.add(s);
        continue;
      }
      const containFrac = interArea(s.box, r.box) / Math.max(1e-6, boxArea(s.box));
      if (CONTAINER.has(r.label) && TEXT_LIKE.has(s.label) && containFrac > 0.8) {
        dropped.add(s);
        continue;
      }
      if (iou > 0.7 && !IMAGE_LIKE.has(r.label) && !IMAGE_LIKE.has(s.label)) dropped.add(s);
    }
  }
  return regions.filter((r) => !dropped.has(r));
}
