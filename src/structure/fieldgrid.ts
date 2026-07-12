/**
 * Field-grid detection — compatibility shim over the unified pairing
 * interpreter (structure/pairing/). The old geometric emitters (band split at
 * 1.5×lineHeight, even-column inline gate, claim windows) are gone: they made
 * absolute-threshold decisions that PP-OCR's deflated det boxes sat on the
 * wrong side of. `interpretRegion` scores stacked/inline/table/lines READINGS
 * of the region and returns the argmax with per-pair confidence.
 *
 * Callers that want the full verdict (table vs lines distinction, scores)
 * should use interpretRegion directly; this shim keeps the historical
 * "kv blocks or null" contract.
 */
import { unionBox, type BBox } from '../core/types.ts';
import type { Seg } from './fragments.ts';
import type { Block } from './blocks.ts';
import type { PageMetrics } from './classify.ts';
import { interpretRegion, kvInterpretationToBlocks, type InterpretOptions } from './pairing/interpret.ts';

export interface FieldGridResult {
  blocks: Block[];
  box: BBox;
}

/** Historical column-anchor knob. The interpreter enumerates both anchors (and
 *  a threshold-free variant) and scores them, so this is advisory-only now;
 *  kept so call sites and tests compile unchanged. */
export type ColAnchor = 'center' | 'left';

/** Interpret `segs` (one region) as a field grid. Returns kv blocks (labels
 *  paired with their values, each carrying `pairConf`) plus paragraph blocks
 *  for leftover cells — or null when the region reads as a table or as plain
 *  lines (the caller's table builder / line merger takes over). */
export function detectFieldGrid(segs: Seg[], m: PageMetrics, _anchor: ColAnchor = 'center', opts: InterpretOptions = {}): FieldGridResult | null {
  const interp = interpretRegion(segs, m, opts);
  if (interp.kind !== 'kv') return null;
  const blocks = kvInterpretationToBlocks(interp);
  if (!blocks.some((b) => b.kind === 'kv')) return null;
  return { blocks, box: unionBox(segs.map((s) => s.box)) };
}
