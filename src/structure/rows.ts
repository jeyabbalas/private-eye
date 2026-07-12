/**
 * Row clustering shared by the assembler and the pairing interpreter. Kept in a
 * leaf module (no assemble.ts import) so structure/pairing/ can use it without
 * an import cycle; assemble.ts re-exports both for its existing callers.
 */
import type { Seg } from './fragments.ts';
import { ROW_THRESH } from './fragments.ts';
import { median } from './util.ts';

export function clusterRows(segs: Seg[], lineHeight: number): Seg[][] {
  const sorted = [...segs].sort((a, b) => (a.box.y0 + a.box.y1) / 2 - (b.box.y0 + b.box.y1) / 2);
  const rows: Seg[][] = [];
  let cur: Seg[] = [];
  let center = -Infinity;
  for (const s of sorted) {
    const c = (s.box.y0 + s.box.y1) / 2;
    if (!cur.length || Math.abs(c - center) <= lineHeight * ROW_THRESH) {
      cur.push(s);
      center = median(cur.map((x) => (x.box.y0 + x.box.y1) / 2));
    } else {
      rows.push(cur.sort((a, b) => a.box.x0 - b.box.x0));
      cur = [s];
      center = c;
    }
  }
  if (cur.length) rows.push(cur.sort((a, b) => a.box.x0 - b.box.x0));
  return rows;
}

/** Median center-to-center spacing of consecutive rows (line pitch). */
export function rowPitch(rows: Seg[][]): number {
  const centers = rows
    .map((r) => median(r.map((s) => (s.box.y0 + s.box.y1) / 2)))
    .sort((a, b) => a - b);
  if (centers.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i]! - centers[i - 1]!);
  return median(gaps);
}
