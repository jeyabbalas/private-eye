/**
 * Seeded synthetic field-grid generator for the pairing property tests.
 *
 * Layout-agnostic BY CONSTRUCTION: every cell text is unique across the grid
 * (record/column-indexed pools), so any cross-record or cross-column leakage in
 * the interpreter output is mechanically detectable — a returned pair either
 * exists in `expected` or it combined fragments that never belonged together.
 *
 * The geometry knobs encode the failure regimes diagnosed on the live fixtures
 * WITHOUT copying fixture text: `boxHeightFrac` reproduces PP-OCR's deflated
 * det boxes (glyph-core height ≪ row pitch), `recordGapRatio` sweeps the
 * intra-pair vs inter-record separation, `skewPx` encodes sample1-style page
 * rotation, `wrapProb` the wrapped multi-line values.
 */
import type { BBox } from '../../src/core/types.ts';
import type { Seg } from '../../src/structure/fragments.ts';
import type { PageMetrics } from '../../src/structure/classify.ts';
import { clusterRows, rowPitch } from '../../src/structure/assemble.ts';
import { median, modeRounded } from '../../src/structure/util.ts';

/** Deterministic 32-bit PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GridSpec {
  layout: 'stacked' | 'inline';
  /** stacked: number of field columns (2–4). inline: number of label|value column PAIRS (1–2). */
  nCols: number;
  /** stacked: label+value bands. inline: rows per column pair. */
  nRecords: number;
  /** Row pitch (center-to-center) in px. */
  pitch: number;
  /** Det-box height as a fraction of pitch (PP-OCR deflation: ~0.4–0.95). */
  boxHeightFrac: number;
  /** Inter-record gap / pitch (stacked only). */
  recordGapRatio: number;
  jitterPx?: number;
  /** Linear skew: a cell's y shifts by skewPx × (x / pageWidth). */
  skewPx?: number;
  /** Probability a VALUE cell is dropped (its pair leaves `expected`). */
  missingCellProb?: number;
  /** Count of stray noise fragments scattered inside the grid box. */
  strayFragments?: number;
  /** Probability a value wraps to a continuation line (stacked only). */
  wrapProb?: number;
  /** Print labels with a trailing colon (the easy case; default false). */
  labelColon?: boolean;
  seed: number;
}

export interface SyntheticGrid {
  segs: Seg[];
  m: PageMetrics;
  pageWidth: number;
  /** Ground-truth pairs (labels without trailing colon), row-major reading order. */
  expected: { label: string; value: string }[];
  /** Labels whose value cell was dropped: they must pair with NOTHING. */
  unpairedLabels: string[];
  /** role of each unique text, for leakage checks. */
  roles: Map<string, { record: number; role: 'label' | 'value' | 'stray' }>;
}

const LABEL_A = ['PATIENT', 'CASE', 'SPECIMEN', 'REPORT', 'HOSPITAL', 'ACCESSION', 'REFERRING', 'CLINICAL', 'TUMOR', 'PRIMARY', 'REGIONAL', 'LATERALITY', 'GRADE', 'STAGE', 'MARGIN', 'CONSULTANT', 'PHYSICIAN', 'FACILITY', 'BLOCK', 'SOURCE'];
const LABEL_B = ['NAME', 'NO', 'TYPE', 'DATE', 'SITE', 'ID', 'REF', 'WARD', 'CODE', 'CLASS', 'GROUP', 'STATUS', 'EXTENT', 'SIZE', 'UNIT', 'DESK', 'KEY', 'FORM', 'MARK', 'ZONE'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const SURNAMES = ['ALVANO', 'BEAUFORT', 'CARDOZA', 'DELMONT', 'EASTVALE', 'FIORELLI', 'GRANDER', 'HOLLOWAY', 'IBARROLA', 'JENKS', 'KOVARIK', 'LUNDQUIST'];
const FORENAMES = ['RAMONA', 'CLAUDE', 'EDITH', 'MARCEL', 'GLORIA', 'IFEOMA', 'MARGOT', 'JOHAN', 'SARAI', 'PETRA', 'LINUS', 'TOMAS'];
const SIDES = ['Left', 'Right', 'Upper', 'Lower'];
const ORGANS = ['breast', 'colon', 'skin', 'liver', 'lung', 'kidney'];
const WRAPS = ['MEDICAL WARD', 'FAIRVIEW UNIT', 'ONCOLOGY DESK', 'SURGICAL WING'];

export function labelText(i: number): string {
  return `${LABEL_A[i % LABEL_A.length]} ${LABEL_B[Math.floor(i / LABEL_A.length) % LABEL_B.length]}`;
}

/** Value kinds rotate per cell so every row mixes shapes (date/id/name/plain). */
export function valueText(i: number): string {
  switch (i % 4) {
    case 0:
      return `${String((i * 7) % 28 + 1).padStart(2, '0')} ${MONTHS[i % 12]} ${1950 + (i % 70)}`;
    case 1:
      return `SR-${1000 + i * 37}-${2000 + i * 91}`;
    case 2:
      return `${SURNAMES[i % SURNAMES.length]}, ${FORENAMES[Math.floor(i / SURNAMES.length) % FORENAMES.length]}`;
    default:
      return `${SIDES[i % SIDES.length]} ${ORGANS[Math.floor(i / 4) % ORGANS.length]} biopsy ${i}`;
  }
}

/** PageMetrics exactly the way production callers compute them from segments
 *  (deflated lineHeight = median det-box height; pitch from row clustering). */
export function metricsFor(segs: Seg[], pageWidth: number): PageMetrics {
  const lineHeight = median(segs.map((s) => s.box.y1 - s.box.y0)) || 12;
  const pitch = rowPitch(clusterRows(segs, lineHeight)) || lineHeight;
  const bodyLeft = modeRounded(segs.map((s) => s.x0), Math.max(8, lineHeight * 0.5));
  return { width: pageWidth, lineHeight, pitch, bodyLeft };
}

const PAGE_W = 1275;
const MARGIN_X = 84;
const TOP_Y = 150;

function makeSeg(text: string, x0: number, centerY: number, boxH: number): Seg {
  const charW = Math.max(5, boxH * 0.55);
  const box: BBox = { x0, y0: centerY - boxH / 2, x1: x0 + Math.max(12, text.length * charW), y1: centerY + boxH / 2 };
  return { box, text, conf: 0.95, words: [{ text, box, conf: 0.95 }], x0 };
}

export function makeGrid(spec: GridSpec): SyntheticGrid {
  const rng = mulberry32(spec.seed);
  const jitter = () => (spec.jitterPx ? (rng() * 2 - 1) * spec.jitterPx : 0);
  const boxH = spec.pitch * spec.boxHeightFrac;
  const segs: Seg[] = [];
  const expected: { label: string; value: string }[] = [];
  const unpairedLabels: string[] = [];
  const roles = new Map<string, { record: number; role: 'label' | 'value' | 'stray' }>();
  const colonize = (t: string) => (spec.labelColon ? `${t}:` : t);
  const skewFor = (x: number) => (spec.skewPx ? spec.skewPx * (x / PAGE_W) : 0);

  if (spec.layout === 'stacked') {
    const nPhys = spec.nCols;
    const colX = Array.from({ length: nPhys }, (_, c) => MARGIN_X + (nPhys > 1 ? c * (1100 / (nPhys - 1)) : 0));
    let y = TOP_Y;
    for (let r = 0; r < spec.nRecords; r++) {
      if (r > 0) y += spec.pitch * spec.recordGapRatio;
      const labelY = y;
      const valueY = y + spec.pitch;
      let recordBottom = valueY;
      for (let c = 0; c < nPhys; c++) {
        const i = r * nPhys + c;
        const label = labelText(i);
        const value = valueText(i);
        segs.push(makeSeg(colonize(label), colX[c]!, labelY + jitter() + skewFor(colX[c]!), boxH));
        roles.set(colonize(label), { record: r, role: 'label' });
        if (spec.missingCellProb && rng() < spec.missingCellProb) {
          unpairedLabels.push(label);
          continue;
        }
        segs.push(makeSeg(value, colX[c]!, valueY + jitter() + skewFor(colX[c]!), boxH));
        roles.set(value, { record: r, role: 'value' });
        if (spec.wrapProb && rng() < spec.wrapProb) {
          const wrap = `${WRAPS[i % WRAPS.length]} ${i}`;
          const wrapY = valueY + spec.pitch;
          segs.push(makeSeg(wrap, colX[c]!, wrapY + jitter() + skewFor(colX[c]!), boxH));
          roles.set(wrap, { record: r, role: 'value' });
          recordBottom = Math.max(recordBottom, wrapY);
          expected.push({ label, value: `${value}, ${wrap}` });
        } else {
          expected.push({ label, value });
        }
      }
      y = recordBottom;
    }
  } else {
    const nPairs = spec.nCols;
    const pairX = Array.from({ length: nPairs }, (_, p) => MARGIN_X + p * (1100 / Math.max(1, nPairs)));
    for (let p = 0; p < nPairs; p++) {
      const labelX = pairX[p]!;
      const valueX = labelX + 260;
      for (let r = 0; r < spec.nRecords; r++) {
        const i = r * nPairs + p;
        const label = labelText(i);
        const value = valueText(i);
        const y = TOP_Y + r * spec.pitch + jitter() + skewFor(labelX);
        segs.push(makeSeg(colonize(label), labelX, y, boxH));
        roles.set(colonize(label), { record: i, role: 'label' });
        if (spec.missingCellProb && rng() < spec.missingCellProb) {
          unpairedLabels.push(label);
          continue;
        }
        segs.push(makeSeg(value, valueX, y + jitter(), boxH));
        roles.set(value, { record: i, role: 'value' });
        expected.push({ label, value });
      }
    }
  }

  if (spec.strayFragments) {
    const box = segs.length
      ? {
          x0: Math.min(...segs.map((s) => s.box.x0)),
          y0: Math.min(...segs.map((s) => s.box.y0)),
          x1: Math.max(...segs.map((s) => s.box.x1)),
          y1: Math.max(...segs.map((s) => s.box.y1)),
        }
      : { x0: 0, y0: 0, x1: PAGE_W, y1: 400 };
    for (let k = 0; k < spec.strayFragments; k++) {
      const text = `ZZSTRAY${k}`;
      const x = box.x0 + rng() * (box.x1 - box.x0);
      const y = box.y0 + rng() * (box.y1 - box.y0);
      segs.push(makeSeg(text, x, y, boxH));
      roles.set(text, { record: -1, role: 'stray' });
    }
  }

  segs.sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  return { segs, m: metricsFor(segs, PAGE_W), pageWidth: PAGE_W, expected, unpairedLabels, roles };
}

/** Uniform-scale a grid's geometry (coords AND metrics) — the scale-invariance probe. */
export function scaleGrid(g: SyntheticGrid, k: number): SyntheticGrid {
  const s = (b: BBox): BBox => ({ x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k });
  const segs = g.segs.map((seg) => ({
    ...seg,
    box: s(seg.box),
    x0: seg.x0 * k,
    words: seg.words.map((w) => ({ ...w, box: s(w.box) })),
  }));
  return { ...g, segs, pageWidth: g.pageWidth * k, m: metricsFor(segs, g.pageWidth * k) };
}
