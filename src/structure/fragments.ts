/**
 * Rebuild line segments from OCR word boxes, splitting at column gutters. This
 * is essential because engines like Tesseract merge multi-column rows into a
 * single line ("SURNAME FORENAME Hospital No."); we re-split by large
 * horizontal gaps so each segment belongs to one column.
 */
import type { BBox, OcrResult, OcrWord } from '../core/types.ts';
import { boxHeight, unionBox } from '../core/types.ts';
import { median } from './util.ts';

/** Bullet markers, including Tesseract's misreads (single lowercase letter or
 *  stray punctuation like « ¢). Kept in sync with classify.ts. */
const BULLET_GLYPH = /^(?:[•◦·▪‣*+–—]|[a-z0]|[^\w\s]{1,2})$/i;

export interface Seg {
  box: BBox;
  text: string;
  conf: number;
  words: OcrWord[];
  /** x-start, used for column/indent analysis. */
  x0: number;
}

/** Read a numeric tuning knob from the environment when running under Node
 *  (dev sweeps), falling back to the default everywhere else. Must not reference
 *  a bare `process`, which is undefined in the browser where this code also runs. */
function envNum(name: string, fallback: number): number {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[name];
  return v != null && v !== '' ? Number(v) : fallback;
}

/** Minimum word confidence; below this is usually scanner noise / garbage. */
const MIN_WORD_CONF = envNum('MIN_WORD_CONF', 0.2);

/** Row-clustering tightness: a word joins the current row only if its vertical
 *  center is within ROW_THRESH × line-height of the row center. Tight enough to
 *  separate vertically-staggered side-by-side columns (whose baselines are close
 *  but distinct), loose enough to keep one printed line together despite box
 *  inflation. Shared with assemble.clusterRows so both stages agree. */
export const ROW_THRESH = envNum('ROW_THRESH', 0.6);

function flattenWords(ocr: OcrResult): OcrWord[] {
  const words: OcrWord[] = [];
  for (const line of ocr.lines) {
    if (line.words && line.words.length) words.push(...line.words);
    else words.push({ text: line.text, box: line.box, conf: line.conf });
  }
  return words.filter((w) => w.text.trim().length > 0 && w.conf >= MIN_WORD_CONF);
}

/** Median word-box height of the document — the scale buildLineSegments uses
 *  for row clustering and gutter splitting. Exported so region-scoped callers
 *  (Pipeline E) can compute it once over the FULL page and pass it down. */
export function wordLineHeight(ocr: OcrResult): number {
  const words = flattenWords(ocr);
  return median(words.map((w) => boxHeight(w.box))) || 12;
}

/** Group words into rows by vertical overlap, then split rows into column
 *  segments by gutters. `wordHeight` overrides the document-local scale (used
 *  by region-scoped callers so a subset of lines sees page-global thresholds). */
export function buildLineSegments(ocr: OcrResult, wordHeight?: number): Seg[] {
  const words = flattenWords(ocr);
  if (!words.length) return [];
  const h = wordHeight ?? (median(words.map((w) => boxHeight(w.box))) || 12);

  // Cluster into rows: sort by vertical center, start a new row when the next
  // word's center drops more than ~60% of a line height below the current row.
  const sorted = [...words].sort((a, b) => (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2);
  const rows: OcrWord[][] = [];
  let curRow: OcrWord[] = [];
  let curCenter = -Infinity;
  for (const w of sorted) {
    const c = (w.box.y0 + w.box.y1) / 2;
    if (curRow.length === 0 || Math.abs(c - curCenter) <= h * ROW_THRESH) {
      curRow.push(w);
      curCenter = curRow.length ? median(curRow.map((x) => (x.box.y0 + x.box.y1) / 2)) : c;
    } else {
      rows.push(curRow);
      curRow = [w];
      curCenter = c;
    }
  }
  if (curRow.length) rows.push(curRow);

  // Split each row into column segments at gutters wider than a column threshold.
  const gutter = h * 1.6;
  const segs: Seg[] = [];
  for (const row of rows) {
    const byX = [...row].sort((a, b) => a.box.x0 - b.box.x0);
    const groups: OcrWord[][] = [[byX[0]!]];
    for (let i = 1; i < byX.length; i++) {
      const prev = byX[i - 1]!;
      const w = byX[i]!;
      if (w.box.x0 - prev.box.x1 > gutter) groups.push([w]);
      else groups[groups.length - 1]!.push(w);
    }
    // A leading bullet glyph sits in its own column (hanging indent); keep it
    // attached to the following text so bullets survive gutter splitting.
    for (let g = 0; g < groups.length - 1; g++) {
      const grp = groups[g]!;
      if (grp.length === 1 && BULLET_GLYPH.test(grp[0]!.text)) {
        groups[g + 1] = [...grp, ...groups[g + 1]!];
        groups.splice(g, 1);
        g--;
      }
    }
    for (const group of groups) {
      const box = unionBox(group.map((w) => w.box));
      segs.push({
        box,
        text: group.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim(),
        conf: group.reduce((a, w) => a + w.conf, 0) / group.length,
        words: group,
        x0: box.x0,
      });
    }
  }
  return segs.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
}

/** Median glyph height across segments (a useful scale for thresholds). */
export function segLineHeight(segs: Seg[]): number {
  return median(segs.map((s) => boxHeight(s.box))) || 12;
}
