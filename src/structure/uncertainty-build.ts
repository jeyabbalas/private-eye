/**
 * Shared builders for the UncertaintyLayer, reused by Pipeline E (e-ppstructure)
 * and Pipeline G (vlmregion/assemble). Kept separate from uncertainty.ts (pure
 * types) so pipelines/types.ts can import the contract without pulling in
 * OcrLine/Block dependencies.
 */
import type { BBox, OcrLine } from '../core/types.ts';
import { boxArea, interArea, quadToBox } from '../core/types.ts';
import { geoMean, quantile, type CalibrateFn } from '../core/stats.ts';
import type { DocModel } from './blocks.ts';
import type { BlockProvenance, CharSpan, CoverageGap, LineUncertainty } from './uncertainty.ts';

export type { CalibrateFn };

/** No-op calibrator: surfaces the raw max-softmax (layer.calibration = 'identity'). */
export const identityCalibrate: CalibrateFn = (p) => p;

/** Highlight geometry for a line: prefer the detection quad (true text height)
 *  over the structure-deflated box (PP-OCR compresses box height for layout). */
function lineBox(line: OcrLine): BBox {
  return line.quad ? quadToBox(line.quad) : line.box;
}

/** Per-character spans with calibrated confidence and interpolated geometry.
 *  Empty when an engine provides no aligned per-character confidence. */
function charSpans(text: string, charConf: number[] | undefined, box: BBox, cal: CalibrateFn): CharSpan[] {
  const chars = [...text];
  if (!charConf || charConf.length !== chars.length) return [];
  const w = (box.x1 - box.x0) / chars.length;
  return chars.map((ch, i) => ({
    ch,
    conf: cal(charConf[i]!, ch),
    box: { x0: box.x0 + i * w, y0: box.y0, x1: box.x0 + (i + 1) * w, y1: box.y1 },
  }));
}

/** Build per-line uncertainty. `lineId` is the index into `lines` — the same
 *  index coverage gaps and block provenance reference. Aggregations are computed
 *  over the CALIBRATED per-char confidences when present, else fall back to the
 *  line's scalar confidence (engines without per-char data). */
export function buildLineUncertainties(lines: OcrLine[], cal: CalibrateFn): LineUncertainty[] {
  return lines.map((line, i) => {
    const box = lineBox(line);
    const chars = charSpans(line.text, line.charConf, box, cal);
    const cs = chars.map((c) => c.conf);
    const has = cs.length > 0;
    return {
      lineId: i,
      box,
      text: line.text,
      meanLogProb: has ? geoMean(cs) : line.conf,
      min: has ? Math.min(...cs) : line.conf,
      p10: has ? quantile(cs, 0.1) : line.conf,
      n: has ? cs.length : 0,
      chars,
    };
  });
}

/** Orphan-line coverage gaps (OCR text outside every layout region). `clusters`
 *  carry line ids into the same array passed to buildLineUncertainties. */
export function orphanCoverageGaps(clusters: { box: BBox; lineIds: number[] }[]): CoverageGap[] {
  return clusters.map((c) => ({ kind: 'orphan-line', box: c.box, lineIds: c.lineIds }));
}

const PROVENANCE_MIN_FRAC = 0.5;

/** Approach B: associate each rendered block with the OCR lines whose box overlaps
 *  it (≥50% of the line's area), scoring the block by its worst contributing
 *  character confidence. Decoupled from the assembly string-building so block text
 *  logic is untouched; precise enough for hover-to-highlight triage. */
export function blockProvenanceByBox(doc: DocModel, lines: LineUncertainty[]): BlockProvenance[] {
  return doc.blocks.map((b, blockIndex) => {
    const lineIds: number[] = [];
    let worst = 1;
    for (const lu of lines) {
      const la = boxArea(lu.box) || 1e-6;
      if (interArea(b.box, lu.box) / la < PROVENANCE_MIN_FRAC) continue;
      lineIds.push(lu.lineId);
      const w = lu.chars.length ? Math.min(...lu.chars.map((c) => c.conf)) : lu.min;
      if (w < worst) worst = w;
    }
    return {
      blockIndex,
      kind: b.kind,
      box: b.box,
      lineIds,
      worst: lineIds.length ? worst : 1,
      // Pairing confidence rides along block provenance so BOTH pipelines (E
      // via buildRegionUncertainty, G via buildDocFromReplay) surface it
      // without schema changes elsewhere.
      ...(b.kind === 'kv' && b.pairConf !== undefined ? { pairing: b.pairConf } : {}),
    };
  });
}
