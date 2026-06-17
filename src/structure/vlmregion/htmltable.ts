/**
 * Minimal HTML-table reader for VLM region output (doc-VLMs emit tables as
 * HTML). No DOM dependency: a tolerant tag scanner builds a rectangular grid
 * with colspan/rowspan occupancy, then flattens EXACTLY like Pipeline E's
 * fillTableCells per GROUND_TRUTH_CONVENTIONS:
 *   - >= 2 header rows collapse to ONE row whose cells space-join the distinct
 *     covering-cell texts down each column;
 *   - body spans put text in the span's top-left slot, '' elsewhere.
 * Malformed/empty input returns null — callers fall back to the OCR path.
 */

interface HtmlCell {
  text: string;
  rowSpan: number;
  colSpan: number;
  header: boolean;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
};

function cellText(inner: string): string {
  let t = inner.replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]*>/g, ' ');
  for (const [k, v] of Object.entries(ENTITIES)) t = t.split(k).join(v);
  return t.replace(/\s+/g, ' ').trim();
}

function spanOf(attrs: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(attrs);
  const v = m ? Number(m[1]) : 1;
  return Number.isFinite(v) && v >= 1 ? Math.min(v, 50) : 1;
}

interface HtmlRow {
  cells: HtmlCell[];
  inThead: boolean;
}

function parseRows(tableHtml: string): HtmlRow[] {
  const theadMatch = /<thead[\s>][\s\S]*?<\/thead>/i.exec(tableHtml);
  const theadSpan: [number, number] = theadMatch ? [theadMatch.index, theadMatch.index + theadMatch[0].length] : [-1, -1];
  const rows: HtmlRow[] = [];
  // Split on <tr (closing tags optional — VLM HTML is often sloppy).
  const trRe = /<tr[^>]*>/gi;
  let m: RegExpExecArray | null;
  const starts: number[] = [];
  while ((m = trRe.exec(tableHtml))) starts.push(m.index);
  for (let i = 0; i < starts.length; i++) {
    const chunk = tableHtml.slice(starts[i]!, i + 1 < starts.length ? starts[i + 1]! : tableHtml.length);
    const cells: HtmlCell[] = [];
    const cellRe = /<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr|<tr|<\/table|$)/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(chunk))) {
      const inner = c[3]!.replace(/<\/t[dh]>\s*$/i, '');
      cells.push({
        text: cellText(inner),
        rowSpan: spanOf(c[2]!, 'rowspan'),
        colSpan: spanOf(c[2]!, 'colspan'),
        header: c[1]!.toLowerCase() === 'h',
      });
    }
    if (cells.length) rows.push({ cells, inThead: theadSpan[0] >= 0 && starts[i]! > theadSpan[0] && starts[i]! < theadSpan[1] });
  }
  return rows;
}

/** Parse the FIRST <table> in `html` into a flattened rectangular grid (row 0 =
 *  header per GFM convention). Returns null when no usable table is found. */
export function htmlTableToGrid(html: string): string[][] | null {
  const tm = /<table[\s>][\s\S]*?(?:<\/table>|$)/i.exec(html);
  if (!tm) return null;
  const rows = parseRows(tm[0]);
  if (rows.length < 1) return null;

  // Header rows: <thead> rows, else leading all-<th> rows.
  let theadRows = rows.filter((r) => r.inThead).length;
  if (theadRows === 0) {
    while (theadRows < rows.length && rows[theadRows]!.cells.every((c) => c.header) && rows[theadRows]!.cells.length > 0) theadRows++;
    if (theadRows === rows.length) theadRows = rows.length > 1 ? 1 : 0; // all-<th> table: keep 1 header row
  }

  // Occupancy: every covered (row, col) slot records its covering cell's text +
  // identity (fillTableCells' cellAt semantics); `top` marks the span's
  // top-left slot. A rowspan started at fromRow covers its column through
  // untilRow in every FOLLOWING row.
  interface Slot {
    text: string;
    top: boolean;
    id: number;
  }
  const nRows = rows.length;
  let nCols = 0;
  let cellId = 0;
  const occ: Slot[][] = Array.from({ length: nRows }, () => []);
  const spans: { col: number; fromRow: number; untilRow: number; text: string; id: number }[] = [];
  for (let r = 0; r < nRows; r++) {
    let col = 0;
    const covering = new Map(spans.filter((s) => r > s.fromRow && r <= s.untilRow).map((s) => [s.col, s]));
    const skipTaken = () => {
      for (let s = covering.get(col); s; s = covering.get(col)) {
        occ[r]![col] = { text: s.text, top: false, id: s.id };
        col++;
      }
    };
    for (const cell of rows[r]!.cells) {
      skipTaken();
      const id = cellId++;
      for (let k = 0; k < cell.colSpan; k++) {
        occ[r]![col + k] = { text: cell.text, top: k === 0, id };
        if (cell.rowSpan > 1) spans.push({ col: col + k, fromRow: r, untilRow: r + cell.rowSpan - 1, text: cell.text, id });
      }
      col += cell.colSpan;
    }
    skipTaken();
    nCols = Math.max(nCols, col);
  }
  if (nCols < 1) return null;

  const grid: string[][] = [];
  if (theadRows >= 2) {
    // Collapse to ONE header row: space-join the distinct covering-cell texts
    // down each column (dedup by cell identity, exactly like fillTableCells).
    const header: string[] = [];
    for (let c = 0; c < nCols; c++) {
      const parts: string[] = [];
      const seen = new Set<number>();
      for (let r = 0; r < theadRows; r++) {
        const slot = occ[r]?.[c];
        if (!slot || seen.has(slot.id)) continue;
        seen.add(slot.id);
        if (slot.text) parts.push(slot.text);
      }
      header.push(parts.join(' '));
    }
    grid.push(header);
  }
  for (let r = theadRows >= 2 ? theadRows : 0; r < nRows; r++) {
    const row: string[] = [];
    for (let c = 0; c < nCols; c++) {
      const slot = occ[r]?.[c];
      row.push(slot?.top ? slot.text : '');
    }
    grid.push(row);
  }
  const usable = grid.length >= 1 && grid.some((r) => r.some((c) => c.trim()));
  return usable ? grid : null;
}

/**
 * PaddleOCR-VL's table dialect (its tech-report token set, not HTML):
 * `<fcel>text` opens a filled cell, `<ecel>` an empty cell, `<lcel>`/`<ucel>`
 * continue a col/row span, `<nl>` ends a row. Spans flatten to '' continuation
 * slots (the GFM convention used everywhere else here).
 */
export function fcelTableToGrid(text: string): string[][] | null {
  if (!/<fcel>|<ecel>/.test(text)) return null;
  const grid: string[][] = [];
  for (const rowChunk of text.split('<nl>')) {
    const cells: string[] = [];
    const re = /<(fcel|ecel|lcel|ucel|xcel)>([^<]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rowChunk))) {
      cells.push(m[1] === 'fcel' ? m[2]!.replace(/\s+/g, ' ').trim() : '');
    }
    if (cells.length) grid.push(cells);
  }
  const usable = grid.length >= 1 && grid.some((r) => r.some((c) => c.trim()));
  return usable ? grid : null;
}

function gridToGfm(grid: string[][]): string {
  const cols = Math.max(...grid.map((r) => r.length));
  const pad = (row: string[]) => [...row, ...Array(Math.max(0, cols - row.length)).fill('')];
  const esc = (c: string) => c.replace(/\|/g, '/');
  const lines = [`| ${pad(grid[0]!).map(esc).join(' | ')} |`, `| ${pad(grid[0]!).map(() => '---').join(' | ')} |`];
  for (const row of grid.slice(1)) lines.push(`| ${pad(row).map(esc).join(' | ')} |`);
  return lines.join('\n');
}

/** Replace every <table>…</table> in markdown with its GFM rendering (so a
 *  single GFM parse downstream sees them); unusable tables are stripped. */
export function inlineHtmlTables(md: string): string {
  return md.replace(/<table[\s>][\s\S]*?(?:<\/table>|$)/gi, (chunk) => {
    const grid = htmlTableToGrid(chunk);
    return grid ? `\n\n${gridToGfm(grid)}\n\n` : '\n\n';
  });
}
