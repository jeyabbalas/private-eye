/** Build a GFM table from a multi-column region of line segments. */
import type { BBox } from '../core/types.ts';
import { unionBox } from '../core/types.ts';
import type { Seg } from './fragments.ts';
import type { Block } from './blocks.ts';
import { clusterByGap, nearestIndex } from './util.ts';

const centerX = (b: BBox) => (b.x0 + b.x1) / 2;

/** Generic column-header words that signal a data table rather than a label/value field grid. */
const HEADER_WORDS = new Set([
  'feature',
  'features',
  'item',
  'items',
  'test',
  'tests',
  'parameter',
  'parameters',
  'antibody',
  'marker',
  'field',
  'property',
  'attribute',
  'name',
  'description',
  'value',
  'result',
]);

export function firstCellIsHeaderWord(rows: Seg[][]): boolean {
  const first = rows[0]?.[0]?.text.trim().toLowerCase() ?? '';
  return HEADER_WORDS.has(first);
}

/** Assemble a table Block: cluster columns by left edge (x0) — table cells are
 *  left-aligned, and a wide header (e.g. "Reference Range") shares the left edge
 *  of its narrower data even when their centers differ. */
export function buildTable(rows: Seg[][], lineHeight: number): Block {
  const allSegs = rows.flat();
  const colLefts = clusterByGap(allSegs.map((s) => s.box.x0), lineHeight * 2.2);
  const cells: string[][] = [];
  const rowBoxes: BBox[] = [];
  for (const row of rows) {
    const cols: string[] = Array(colLefts.length).fill('');
    for (const seg of row) {
      const c = nearestIndex(colLefts, seg.box.x0);
      cols[c] = cols[c] ? `${cols[c]} ${seg.text}`.trim() : seg.text.trim();
    }
    const box = unionBox(row.map((s) => s.box));
    // A row with an empty first (label) column directly below another row is a
    // wrapped cell continuation, not a new record: fold it into the row above.
    const prevBox = rowBoxes[rowBoxes.length - 1];
    if (cells.length && !cols[0]!.trim() && prevBox && box.y0 - prevBox.y1 < lineHeight * 1.2) {
      const prev = cells[cells.length - 1]!;
      for (let c = 0; c < cols.length; c++) {
        if (cols[c]!.trim()) prev[c] = prev[c] ? `${prev[c]} ${cols[c]}`.trim() : cols[c]!;
      }
      rowBoxes[rowBoxes.length - 1] = unionBox([prevBox, box]);
      continue;
    }
    cells.push(cols);
    rowBoxes.push(box);
  }
  return { kind: 'table', cells, box: unionBox(allSegs.map((s) => s.box)) };
}
