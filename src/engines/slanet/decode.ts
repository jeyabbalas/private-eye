/**
 * Pure SLANet_plus structure decode, mirroring PaddleOCR TableLabelDecode
 * (ppocr/postprocess/table_postprocess.py) with merge_no_span_structure=true:
 *   - vocab transform: remove '<td>', append '<td></td>', then wrap with
 *     sos (index 0) / eos (last) — matches the model's 50-dim structure head
 *     (48 yml dict tokens + sos + eos)
 *   - greedy argmax per step; break at eos (when step > 0); skip sos
 *   - a cell OPENS at a td token ('<td></td>' complete cell, or '<td' followed
 *     by span attribute tokens then '>'); its loc_preds row (8 = xyxyxyxy quad,
 *     normalized to the 488x488 padded canvas) is taken at that step and mapped
 *     back to crop pixels via _bbox_decode semantics: *pad_size then /ratio
 *   - grid placement: walk <tr> rows, place cells left-to-right skipping slots
 *     occupied by rowspans from earlier rows; <thead> rows tracked.
 */
import type { BBox, Quad } from '../../core/types.ts';
import { quadToBox } from '../../core/types.ts';

export interface TableCell {
  quad: Quad;
  /** Axis-aligned bounds of quad, in CROP pixel coordinates. */
  box: BBox;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  inThead: boolean;
}

export interface TableStructure {
  cells: TableCell[];
  nRows: number;
  nCols: number;
  /** Number of leading rows that belong to <thead>. */
  theadRows: number;
  tokens: string[];
}

/** PaddleOCR TableLabelDecode.__init__ + add_special_char (AttnLabelDecode). */
export function buildTableVocab(characterDict: string[], mergeNoSpanStructure: boolean): string[] {
  let dict = [...characterDict];
  if (mergeNoSpanStructure) {
    if (!dict.includes('<td></td>')) dict.push('<td></td>');
    dict = dict.filter((t) => t !== '<td>');
  }
  return ['sos', ...dict, 'eos'];
}

const TD_TOKENS = new Set(['<td>', '<td', '<td></td>']);
const SPAN_RE = /^ (colspan|rowspan)="(\d+)"$/;

export function decodeTable(
  structProbs: Float32Array,
  locPreds: Float32Array,
  T: number,
  V: number,
  vocab: string[],
  padSize: number,
  ratio: number,
): TableStructure {
  const endIdx = vocab.length - 1; // 'eos'
  const begIdx = 0; // 'sos'

  interface PendingCell {
    quad: Quad;
    rowSpan: number;
    colSpan: number;
  }
  const tokens: string[] = [];
  const rows: PendingCell[][] = [];
  const rowInHead: boolean[] = [];
  let section: 'head' | 'body' = 'body';
  let curRow: PendingCell[] | null = null;
  let lastCell: PendingCell | null = null;

  const openRow = (): PendingCell[] => {
    if (!curRow) {
      curRow = [];
      rows.push(curRow);
      rowInHead.push(section === 'head');
    }
    return curRow;
  };

  for (let t = 0; t < T; t++) {
    let arg = 0;
    let mx = -Infinity;
    const off = t * V;
    for (let v = 0; v < V; v++) {
      const p = structProbs[off + v]!;
      if (p > mx) {
        mx = p;
        arg = v;
      }
    }
    if (t > 0 && arg === endIdx) break;
    if (arg === begIdx || arg === endIdx) continue;
    const tok = vocab[arg]!;
    tokens.push(tok);

    if (tok === '<thead>') section = 'head';
    else if (tok === '</thead>') section = 'body';
    else if (tok === '<tr>') openRow();
    else if (tok === '</tr>') curRow = null;
    else if (TD_TOKENS.has(tok)) {
      const lo = t * 8;
      // _bbox_decode: bbox * pad_{w,h} then / ratio_{w,h} -> original crop px.
      const k = padSize / ratio;
      const quad: Quad = [
        [locPreds[lo]! * k, locPreds[lo + 1]! * k],
        [locPreds[lo + 2]! * k, locPreds[lo + 3]! * k],
        [locPreds[lo + 4]! * k, locPreds[lo + 5]! * k],
        [locPreds[lo + 6]! * k, locPreds[lo + 7]! * k],
      ];
      lastCell = { quad, rowSpan: 1, colSpan: 1 };
      openRow().push(lastCell);
    } else {
      const m = SPAN_RE.exec(tok);
      if (m && lastCell) {
        if (m[1] === 'colspan') lastCell.colSpan = Number(m[2]);
        else lastCell.rowSpan = Number(m[2]);
      }
    }
  }

  // Grid placement with span occupancy.
  const occupied = new Set<string>(); // "row,col"
  const cells: TableCell[] = [];
  let nCols = 0;
  let nRows = 0;
  for (let r = 0; r < rows.length; r++) {
    let col = 0;
    for (const pc of rows[r]!) {
      while (occupied.has(`${r},${col}`)) col++;
      for (let dr = 0; dr < pc.rowSpan; dr++) {
        for (let dc = 0; dc < pc.colSpan; dc++) occupied.add(`${r + dr},${col + dc}`);
      }
      cells.push({
        quad: pc.quad,
        box: quadToBox(pc.quad),
        row: r,
        col,
        rowSpan: pc.rowSpan,
        colSpan: pc.colSpan,
        inThead: rowInHead[r]!,
      });
      nCols = Math.max(nCols, col + pc.colSpan);
      nRows = Math.max(nRows, r + pc.rowSpan);
      col += pc.colSpan;
    }
  }
  let theadRows = 0;
  while (theadRows < rowInHead.length && rowInHead[theadRows]) theadRows++;
  return { cells, nRows, nCols, theadRows, tokens };
}
