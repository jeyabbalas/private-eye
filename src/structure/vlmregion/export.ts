/**
 * Region-export construction shared by the disk exporter
 * (scripts/export-regions.ts, Node/sharp) and the live-crop browser path
 * (the eval harness VLM probe): layout regions + OCR lines -> ExportRegion
 * records with axis-aligned padded crops. PNG encoding stays caller-side
 * (sharp in Node, OffscreenCanvas in the browser); this module is pure so the
 * regionKey/crop geometry is bit-identical in both runtimes.
 */
import type { BBox, OcrLine, RasterImage } from '../../core/types.ts';
import { assignLinesToRegions } from '../region-assemble.ts';
import { kindOf, regionKey, type ExportLine, type ExportRegion } from './replay.ts';

const r2 = (v: number) => Math.round(v * 100) / 100;
export const roundBox = (b: BBox): BBox => ({ x0: r2(b.x0), y0: r2(b.y0), x1: r2(b.x1), y1: r2(b.y1) });
export const exportLine = (l: OcrLine): ExportLine => ({ text: l.text, conf: Math.round(l.conf * 1e4) / 1e4, box: roundBox(l.box) });

/** Axis-aligned integer crop (bit-exact row copy — no resampling). */
export function cropRect(img: RasterImage, b: BBox): { crop: RasterImage; rect: BBox } {
  const x0 = Math.max(0, Math.floor(b.x0));
  const y0 = Math.max(0, Math.floor(b.y0));
  const x1 = Math.min(img.width, Math.ceil(b.x1));
  const y1 = Math.min(img.height, Math.ceil(b.y1));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    out.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { crop: { data: out, width: w, height: h }, rect: { x0, y0, x1: x0 + w, y1: y0 + h } };
}

/** Minimal structural view of a layout-engine region (no engines/ import). */
export interface LayoutRegionLike {
  label: string;
  score: number;
  orderRank: number;
  box: BBox;
}

export interface BuiltRegions {
  regions: ExportRegion[];
  /** Crops by region index (only for non-skipped regions); caller encodes PNGs
   *  under the canonical region-NNN.png names already filled into regions[]. */
  crops: Map<number, RasterImage>;
  orphanLines: ExportLine[];
}

/** The export loop of scripts/export-regions.ts, verbatim semantics:
 *  assign OCR lines (IoU/center rules), classify kind, skip imageish-no-text
 *  and sub-minPx crops, pad+clamp the rest. */
export function buildExportRegions(
  image: RasterImage,
  layoutRegions: LayoutRegionLike[],
  ocrLines: OcrLine[],
  opts: { pad: number; minPx: number },
): BuiltRegions {
  const assignment = assignLinesToRegions(ocrLines, layoutRegions);
  const buckets: OcrLine[][] = layoutRegions.map(() => []);
  const orphans: OcrLine[] = [];
  ocrLines.forEach((line, i) => {
    const r = assignment[i]!;
    if (r >= 0) buckets[r]!.push(line);
    else orphans.push(line);
  });

  const regions: ExportRegion[] = [];
  const crops = new Map<number, RasterImage>();
  for (let i = 0; i < layoutRegions.length; i++) {
    const reg = layoutRegions[i]!;
    const lines = buckets[i]!;
    const kind = kindOf(reg.label);
    const base: ExportRegion = {
      index: i,
      regionKey: regionKey(reg.label, reg.box),
      label: reg.label,
      kind,
      score: Math.round(reg.score * 1e4) / 1e4,
      orderRank: reg.orderRank,
      box: roundBox(reg.box),
      cropBox: null,
      cropPng: null,
      skipped: null,
      lines: lines.map(exportLine),
    };
    if (kind === 'imageish' && lines.length === 0) {
      base.skipped = 'imageish-no-text';
    } else {
      const padded: BBox = { x0: reg.box.x0 - opts.pad, y0: reg.box.y0 - opts.pad, x1: reg.box.x1 + opts.pad, y1: reg.box.y1 + opts.pad };
      const { crop, rect } = cropRect(image, padded);
      if (crop.width < opts.minPx || crop.height < opts.minPx) {
        base.skipped = 'too-small';
      } else {
        base.cropBox = rect;
        base.cropPng = `region-${String(i).padStart(3, '0')}.png`;
        crops.set(i, crop);
      }
    }
    regions.push(base);
  }
  return { regions, crops, orphanLines: orphans.map(exportLine) };
}
