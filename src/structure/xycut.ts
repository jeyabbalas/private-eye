/**
 * Recursive XY-cut reading order. Repeatedly split a set of boxes along the axis
 * with the widest empty gutter (vertical gutter → columns, horizontal gutter →
 * stacked bands), recursing left→right then top→bottom. Falls back to
 * top-to-bottom / left-to-right when no significant gutter remains. Pure
 * algorithm, no model — portable to the browser unchanged.
 */
import type { BBox } from '../core/types.ts';

export interface Ordered {
  box: BBox;
  index: number; // original index, returned in reading order
}

/** Largest gap between non-overlapping projected intervals on one axis. */
function widestGap(intervals: [number, number][]): { gap: number; cut: number } {
  if (intervals.length < 2) return { gap: 0, cut: 0 };
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let maxEnd = sorted[0]![1];
  let best = { gap: 0, cut: 0 };
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i]!;
    if (s > maxEnd) {
      const gap = s - maxEnd;
      if (gap > best.gap) best = { gap, cut: (maxEnd + s) / 2 };
    }
    maxEnd = Math.max(maxEnd, e);
  }
  return best;
}

function cut(items: Ordered[], minGap: number, out: Ordered[]): void {
  if (items.length <= 1) {
    if (items.length) out.push(items[0]!);
    return;
  }
  const vGap = widestGap(items.map((it) => [it.box.x0, it.box.x1] as [number, number]));
  const hGap = widestGap(items.map((it) => [it.box.y0, it.box.y1] as [number, number]));

  // Prefer a vertical cut (columns) when its gutter is at least as wide as the
  // horizontal one; this keeps multi-column regions in column order.
  if (vGap.gap >= hGap.gap && vGap.gap >= minGap) {
    const left = items.filter((it) => (it.box.x0 + it.box.x1) / 2 < vGap.cut);
    const right = items.filter((it) => (it.box.x0 + it.box.x1) / 2 >= vGap.cut);
    cut(left, minGap, out);
    cut(right, minGap, out);
    return;
  }
  if (hGap.gap >= minGap) {
    const top = items.filter((it) => (it.box.y0 + it.box.y1) / 2 < hGap.cut);
    const bottom = items.filter((it) => (it.box.y0 + it.box.y1) / 2 >= hGap.cut);
    cut(top, minGap, out);
    cut(bottom, minGap, out);
    return;
  }
  // No significant gutter: stable reading order top→bottom, then left→right.
  for (const it of [...items].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)) out.push(it);
}

/** Return original indices of `boxes` in reading order. `minGap` ~ one line height. */
export function xyCutOrder(boxes: BBox[], minGap: number): number[] {
  const items: Ordered[] = boxes.map((box, index) => ({ box, index }));
  const out: Ordered[] = [];
  cut(items, minGap, out);
  return out.map((o) => o.index);
}
