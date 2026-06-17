/**
 * Field-grid detection — THE hard part of these documents. Two layouts occur:
 *
 *  - label-above-value (sample1/sample3 header): columns each contain a label
 *    row then value row(s); multi-line values stack under their label.
 *  - inline label|value (sample2 header): columns alternate label,value,label,…
 *
 * Discriminator: column homogeneity. If columns alternate label-heavy /
 * value-heavy, it's inline; otherwise rows pair as label-band → value-band.
 * Output is row-major kv blocks (per GROUND_TRUTH_CONVENTIONS.md).
 */
import type { BBox } from '../core/types.ts';
import { unionBox } from '../core/types.ts';
import type { Seg } from './fragments.ts';
import type { Block } from './blocks.ts';
import type { PageMetrics } from './classify.ts';
import { clusterByGap, nearestIndex } from './util.ts';

const wordCount = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const hasDigit = (t: string) => /\d/.test(t);
const valueish = (t: string) => hasDigit(t) || wordCount(t) >= 5;
const labelish = (t: string) => !valueish(t) && wordCount(t) <= 4 && t.length <= 30;
const centerX = (b: BBox) => (b.x0 + b.x1) / 2;
const centerY = (b: BBox) => (b.y0 + b.y1) / 2;

export interface FieldGridResult {
  blocks: Block[];
  box: BBox;
}

/** How to anchor column clustering. 'center' is Pipeline B's original behavior;
 *  'left' clusters by left edge — stable when a value wraps to a shorter second
 *  line (centerX drifts inward and fabricates a phantom column). */
export type ColAnchor = 'center' | 'left';

/** Try to interpret `segs` (one region) as a field grid. Returns null if it isn't one. */
export function detectFieldGrid(segs: Seg[], m: PageMetrics, anchor: ColAnchor = 'center'): FieldGridResult | null {
  if (segs.length < 3) return null;

  const colOf = (b: BBox) => (anchor === 'left' ? b.x0 : centerX(b));
  const colCenters = clusterByGap(segs.map((s) => colOf(s.box)), m.lineHeight * 2.2);
  if (colCenters.length < 2) return null;

  // Assign each seg to a column and a row.
  const rowCenters = clusterByGap(segs.map((s) => centerY(s.box)), m.lineHeight * 0.7);
  const ncols = colCenters.length;
  const nrows = rowCenters.length;
  const grid: (Seg | undefined)[][] = Array.from({ length: nrows }, () => Array<Seg | undefined>(ncols).fill(undefined));
  const rowY: number[] = Array(nrows).fill(0);
  for (const s of segs) {
    const c = nearestIndex(colCenters, colOf(s.box));
    const r = nearestIndex(rowCenters, centerY(s.box));
    // If two segs collide in a cell, append (keeps stray fragments together).
    const existing = grid[r]![c];
    grid[r]![c] = existing ? { ...existing, box: unionBox([existing.box, s.box]), text: `${existing.text} ${s.text}`.trim() } : s;
    rowY[r] = rowCenters[r]!;
  }

  // Column homogeneity: fraction of value-ish cells per column.
  const valueFrac = colCenters.map((_, c) => {
    const cells = grid.map((row) => row[c]).filter((x): x is Seg => !!x);
    if (!cells.length) return 0.5;
    return cells.filter((s) => valueish(s.text)).length / cells.length;
  });

  const box = unionBox(segs.map((s) => s.box));
  const inline = isInlineLayout(ncols, valueFrac);
  const blocks = inline ? emitInline(segs, colCenters, m, anchor) : emitStacked(grid, rowY, m);
  return blocks.length ? { blocks, box } : null;
}

/** Inline when columns alternate label-heavy (even) / value-heavy (odd). */
function isInlineLayout(ncols: number, valueFrac: number[]): boolean {
  if (ncols % 2 !== 0) return false;
  let pairs = 0;
  let good = 0;
  for (let c = 0; c + 1 < ncols; c += 2) {
    pairs++;
    if (valueFrac[c]! < 0.45 && valueFrac[c + 1]! > 0.45) good++;
  }
  return pairs > 0 && good / pairs >= 0.5;
}

/**
 * Inline layout: columns pair up (label, value, label, value, …). Each
 * (label-col, value-col) pair is processed as an INDEPENDENT vertical stack —
 * this is what makes two side-by-side field columns (sample2.001) work even
 * when their rows are vertically staggered and so cannot be globally
 * row-clustered. Within a pair, each label claims every value-column segment
 * from its own baseline down to the next label's (joining wrapped multi-line
 * values with ", "). Pairs are then merged in reading order (label y, then x).
 */
function emitInline(segs: Seg[], colCenters: number[], m: PageMetrics, anchor: ColAnchor): Block[] {
  const colOf = (b: BBox) => (anchor === 'left' ? b.x0 : centerX(b));
  const byCol: Seg[][] = colCenters.map(() => []);
  for (const s of segs) byCol[nearestIndex(colCenters, colOf(s.box))]!.push(s);
  for (const col of byCol) col.sort((a, b) => centerY(a.box) - centerY(b.box));

  const kvs: { label: string; value: string; box: BBox; y: number; x: number }[] = [];
  for (let lc = 0; lc + 1 < colCenters.length; lc += 2) {
    const labels = byCol[lc]!;
    const values = byCol[lc + 1]!;
    for (let i = 0; i < labels.length; i++) {
      const label = labels[i]!;
      const labelText = label.text.trim().replace(/:$/, '');
      if (!labelText || labelText === ':') continue;
      const yTop = centerY(label.box);
      // Claim value segments up to the next label in this same column.
      const yBot = i + 1 < labels.length ? centerY(labels[i + 1]!.box) : Infinity;
      const claimed = values.filter((v) => {
        const cy = centerY(v.box);
        return cy >= yTop - m.lineHeight * 0.6 && cy < yBot - m.lineHeight * 0.6;
      });
      const value = claimed.map((v) => v.text.trim()).filter(Boolean).join(', ');
      kvs.push({
        label: labelText,
        value,
        box: unionBox([label.box, ...claimed.map((v) => v.box)]),
        y: yTop,
        x: colCenters[lc]!,
      });
    }
  }
  kvs.sort((a, b) => a.y - b.y || a.x - b.x);
  return kvs.map(({ label, value, box }) => ({ kind: 'kv', label, value, box }));
}

/** Stacked: each band = one label row followed by value row(s). Multi-line
 *  values in a column are joined with ", ". Bands are split at loose row gaps. */
function emitStacked(grid: (Seg | undefined)[][], rowY: number[], m: PageMetrics): Block[] {
  const looseGap = m.lineHeight * 1.5;
  // Partition rows into bands by vertical gap.
  const bands: number[][] = [];
  let cur: number[] = [];
  for (let r = 0; r < rowY.length; r++) {
    if (cur.length && rowY[r]! - rowY[cur[cur.length - 1]!]! > looseGap) {
      bands.push(cur);
      cur = [];
    }
    cur.push(r);
  }
  if (cur.length) bands.push(cur);

  const blocks: Block[] = [];
  for (const band of bands) {
    const labelRow = grid[band[0]!]!;
    const valueRows = band.slice(1).map((r) => grid[r]!);
    const cols = labelRow.length;
    let emitted = false;
    for (let c = 0; c < cols; c++) {
      const label = labelRow[c];
      if (!label?.text.trim()) continue;
      const values = valueRows.map((row) => row[c]).filter((x): x is Seg => !!x && !!x.text.trim());
      const value = values.map((v) => v.text.trim()).join(', ');
      if (value) {
        blocks.push({ kind: 'kv', label: label.text.trim().replace(/:$/, ''), value, box: unionBox([label.box, ...values.map((v) => v.box)]) });
      } else {
        // Single-row band cell (e.g. org name / report no.): keep as a line.
        blocks.push({ kind: 'paragraph', text: label.text.trim(), box: label.box });
      }
      emitted = true;
    }
    if (!emitted) {
      for (const r of band) for (const cell of grid[r]!) if (cell?.text.trim()) blocks.push({ kind: 'paragraph', text: cell.text.trim(), box: cell.box });
    }
  }
  return blocks;
}
