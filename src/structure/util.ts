/** Small numeric/clustering helpers for the structure layer. */

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * 1-D clustering by gap: sort values, start a new cluster when the gap to the
 * previous value exceeds `gap`. Returns cluster centers (means) sorted ascending.
 */
export function clusterByGap(values: number[], gap: number): number[] {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i]!;
    const cur = clusters[clusters.length - 1]!;
    if (v - cur[cur.length - 1]! > gap) clusters.push([v]);
    else cur.push(v);
  }
  return clusters.map((c) => mean(c));
}

/** Most common value after rounding to `bin`-sized buckets (ties → smaller value). */
export function modeRounded(values: number[], bin: number): number {
  if (!values.length) return 0;
  const counts = new Map<number, number>();
  for (const v of values) {
    const k = Math.round(v / bin) * bin;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let bestK = Infinity;
  let bestC = -1;
  for (const [k, c] of counts) {
    if (c > bestC || (c === bestC && k < bestK)) {
      bestC = c;
      bestK = k;
    }
  }
  return bestK;
}

/** Index of the nearest center to v. */
export function nearestIndex(centers: number[], v: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < centers.length; i++) {
    const d = Math.abs(centers[i]! - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
