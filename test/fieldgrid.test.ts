/**
 * Property/invariant tests for field-grid pairing (detectFieldGrid seam).
 *
 * NO MAGIC NUMBERS OF THEIR OWN: assertions are exact pair sets over seeded
 * synthetic grids (test/helpers/synthetic-grids.ts) plus ORDERING-ONLY
 * confidence checks. Regression micro-fixtures encode geometries measured on
 * the live fixtures (coordinates only — no fixture text is scored here; the
 * fixtures themselves stay transfer-only for the pairing harness).
 *
 * `it.fails(...)` marks a KNOWN-BROKEN case under the current interpreter — a
 * ratchet: vitest goes red the moment the fix makes it pass, forcing the flip
 * to a normal `it`.
 */
import { describe, expect, it } from 'vitest';
import type { BBox } from '../src/core/types.ts';
import type { Block } from '../src/structure/blocks.ts';
import { renderMarkdown } from '../src/structure/blocks.ts';
import type { PageMetrics } from '../src/structure/classify.ts';
import { detectFieldGrid } from '../src/structure/fieldgrid.ts';
import type { Seg } from '../src/structure/fragments.ts';
import { extractKvPairs } from '../src/eval/pairing.ts';
import { makeGrid, metricsFor, scaleGrid, type GridSpec } from './helpers/synthetic-grids.ts';

const seg = (text: string, x0: number, centerY: number, h: number): Seg => {
  const charW = Math.max(5, h * 0.55);
  const box: BBox = { x0, y0: centerY - h / 2, x1: x0 + Math.max(12, text.length * charW), y1: centerY + h / 2 };
  return { box, text, conf: 0.95, words: [{ text, box, conf: 0.95 }], x0 };
};

type Kv = { label: string; value: string; pairConf?: number };
const pairsOf = (blocks: Block[] | undefined): Kv[] =>
  (blocks ?? []).filter((b): b is Extract<Block, { kind: 'kv' }> => b.kind === 'kv').map((b) => ({ label: b.label, value: b.value, pairConf: b.pairConf }));

const asSet = (pairs: { label: string; value: string }[]): Set<string> => new Set(pairs.map((p) => `${p.label} = ${p.value}`));

const run = (g: { segs: Seg[]; m: PageMetrics }) => pairsOf(detectFieldGrid(g.segs, g.m, 'left')?.blocks);

const base: GridSpec = { layout: 'stacked', nCols: 3, nRecords: 2, pitch: 29, boxHeightFrac: 0.5, recordGapRatio: 1.6, seed: 1 };

describe('stacked grids — exact pairing', () => {
  it('previously-working regime stays intact (near-true box heights, wide record gaps)', () => {
    const g = makeGrid({ ...base, boxHeightFrac: 0.95, recordGapRatio: 2.5, nRecords: 3 });
    expect(asSet(run(g))).toEqual(asSet(g.expected));
  });

  it('pairs exactly across the ratio × columns × seeds sweep (deflated boxes — the previously-fatal regime)', () => {
    for (const recordGapRatio of [1.4, 1.8, 2.5]) {
      for (const nCols of [2, 3, 4]) {
        for (const seed of [1, 2]) {
          const g = makeGrid({ ...base, recordGapRatio, nCols, seed, nRecords: 3 });
          expect(asSet(run(g)), `ratio=${recordGapRatio} cols=${nCols} seed=${seed}`).toEqual(asSet(g.expected));
        }
      }
    }
  });

  it('deflation invariance: det-box height must not change the pairs (pitch fixed)', () => {
    const sets = [0.45, 0.7, 0.95].map((boxHeightFrac) => asSet(run(makeGrid({ ...base, boxHeightFrac, recordGapRatio: 2.5 }))));
    const gt = asSet(makeGrid({ ...base, boxHeightFrac: 0.7, recordGapRatio: 2.5 }).expected);
    for (const s of sets) expect(s).toEqual(gt);
  });

  it('scale invariance: ×0.5 / ×2 / ×4 coordinates → identical pairs', () => {
    const g = makeGrid({ ...base, boxHeightFrac: 0.95, recordGapRatio: 2.5 });
    const ref = asSet(run(g));
    expect(ref).toEqual(asSet(g.expected));
    for (const k of [0.5, 2, 4]) expect(asSet(run(scaleGrid(g, k))), `scale ×${k}`).toEqual(ref);
  });

  it('wrapped values join their own label and never swallow the next record (working regime)', () => {
    const g = makeGrid({ ...base, boxHeightFrac: 0.95, recordGapRatio: 2.5, wrapProb: 1, seed: 3 });
    expect(asSet(run(g))).toEqual(asSet(g.expected));
  });

  it('wrapped values survive deflated boxes too', () => {
    const g = makeGrid({ ...base, boxHeightFrac: 0.6, recordGapRatio: 2.0, wrapProb: 1, seed: 4 });
    expect(asSet(run(g))).toEqual(asSet(g.expected));
  });

  it('no cross-record leakage; missing value cells never steal a neighbour (subset invariant)', () => {
    for (const seed of [1, 2, 3]) {
      const g = makeGrid({ ...base, boxHeightFrac: 0.95, recordGapRatio: 2.5, missingCellProb: 0.4, jitterPx: 3, seed });
      const got = run(g);
      const allowed = asSet(g.expected);
      for (const p of got) expect(allowed.has(`${p.label} = ${p.value}`), `garbage pair "${p.label} = ${p.value}" (seed ${seed})`).toBe(true);
      for (const lbl of g.unpairedLabels) {
        expect(got.some((p) => p.label === lbl), `label "${lbl}" stole a value (seed ${seed})`).toBe(false);
      }
    }
  });

  it('duplicate labels pair record-locally', () => {
    const h = 27;
    const segs = [
      seg('GRADE', 84, 100, h),
      seg('STAGE', 600, 100, h),
      seg('2', 84, 129, h),
      seg('pT1c pN0', 600, 129, h),
      seg('GRADE', 84, 201, h),
      seg('STAGE', 600, 201, h),
      seg('3', 84, 230, h),
      seg('pT3 N1 M0', 600, 230, h),
    ];
    const got = run({ segs, m: metricsFor(segs, 1275) });
    expect(asSet(got)).toEqual(
      new Set(['GRADE = 2', 'STAGE = pT1c pN0', 'GRADE = 3', 'STAGE = pT3 N1 M0']),
    );
  });
});

describe('inline grids', () => {
  it('label|value column pairs match, independent stacks tolerate stagger', () => {
    const g = makeGrid({ layout: 'inline', nCols: 2, nRecords: 4, pitch: 29, boxHeightFrac: 0.6, recordGapRatio: 1, labelColon: true, skewPx: 6, seed: 5 });
    expect(asSet(run(g))).toEqual(asSet(g.expected));
  });

  it('inline pairing is deflation-invariant', () => {
    const sets = [0.45, 0.95].map((boxHeightFrac) =>
      asSet(run(makeGrid({ layout: 'inline', nCols: 2, nRecords: 3, pitch: 29, boxHeightFrac, recordGapRatio: 1, labelColon: true, seed: 6 }))),
    );
    expect(sets[0]).toEqual(sets[1]);
    expect(sets[0]!.size).toBe(6);
  });
});

describe('degenerate regions — honesty (no confident garbage)', () => {
  it('a micro-grid of VALUE fragments emits no kv pairs (the wrapped-value trap)', () => {
    // Two columns, every cell value-shaped — the shape sample1's wrapped
    // REQUESTOR/SOURCE value forms with its neighbour column. Pairing any of
    // these would fabricate a field.
    const h = 14;
    const segs = [
      seg('ELIZABETH SMITH,', 700, 100, h),
      seg('08 JUN 1942', 300, 100, h),
      seg('MEDICAL WARD,', 700, 124, h),
      seg('434 257 1829', 300, 124, h),
      seg('USA', 700, 148, h),
    ];
    const got = run({ segs, m: metricsFor(segs, 1275) });
    expect(got).toEqual([]);
  });

  it('two ragged columns of prose emit no kv pairs', () => {
    const h = 14;
    const segs = [
      seg('The specimen was received in formalin and', 84, 100, h),
      seg('sectioned at three levels for review.', 700, 100, h),
      seg('Margins appear clear of tumour involvement', 84, 124, h),
      seg('and no vascular invasion is identified.', 700, 124, h),
    ];
    expect(run({ segs, m: metricsFor(segs, 1275) })).toEqual([]);
  });

  it('a single column of prose is not a grid at all', () => {
    const h = 14;
    const segs = [
      seg('The specimen was received in formalin.', 84, 100, h),
      seg('Margins appear clear of tumour.', 84, 124, h),
      seg('No vascular invasion is identified.', 84, 148, h),
    ];
    expect(detectFieldGrid(segs, metricsFor(segs, 1275), 'left')).toBeNull();
  });
});

describe('regression micro-fixtures (geometries measured on live fixtures)', () => {
  it('ho-twocol header geometry: 3 columns × 2 records, deflated 13.8 px boxes → 6 exact pairs', () => {
    // Measured: cols x=[84,586,1093]; row centers [164.5,187.7,227,250];
    // det-box height 13.8; page pitch 29. Row gaps [23.2, 39.3, 23.0] — the
    // old 1.5×lineHeight cutoff (20.7) sat BELOW every gap → total shatter.
    const h = 13.8;
    const m: PageMetrics = { width: 1275, lineHeight: 13.8, pitch: 29, bodyLeft: 84 };
    const segs = [
      seg('PATIENT', 84, 164.5, h),
      seg('MRN', 586, 164.5, h),
      seg('DATE OF BIRTH', 1093, 164.5, h),
      seg('ALVAREZ, RAMON', 84, 187.7, h),
      seg('MR-7781-2240', 586, 187.7, h),
      seg('11 FEB 1968', 1093, 187.7, h),
      seg('ACCESSION', 84, 227, h),
      seg('SEX', 586, 227, h),
      seg('COLLECTED', 1093, 227, h),
      seg('S24-009912', 84, 250, h),
      seg('Male', 586, 250, h),
      seg('03 APR 2024', 1093, 250, h),
    ];
    expect(asSet(pairsOf(detectFieldGrid(segs, m, 'left')?.blocks))).toEqual(
      new Set([
        'PATIENT = ALVAREZ, RAMON',
        'MRN = MR-7781-2240',
        'DATE OF BIRTH = 11 FEB 1968',
        'ACCESSION = S24-009912',
        'SEX = Male',
        'COLLECTED = 03 APR 2024',
      ]),
    );
  });

  it('ho-serif header geometry: 2 columns × 3 records, gaps [19.3,32.5,21.3,31.8,22.3] → 6 exact pairs', () => {
    // 1–2 px used to decide the outcome: old cutoff 20.3 split records 2–3 but
    // fused record 1. The intra (≈20) vs inter (≈32) distinction is only
    // decidable relative to the grid's own gap distribution.
    const h = 13.5;
    const m: PageMetrics = { width: 1275, lineHeight: 13.5, pitch: 27, bodyLeft: 150 };
    const ys = [100, 119.3, 151.8, 173.1, 204.9, 227.2];
    const segs = [
      seg('Patient:', 150, ys[0]!, h),
      seg('Hospital No.:', 700, ys[0]!, h),
      seg('WHITLOCK, EDITH', 150, ys[1]!, h),
      seg('SA-118822', 700, ys[1]!, h),
      seg('Date of Birth:', 150, ys[2]!, h),
      seg('Specimen:', 700, ys[2]!, h),
      seg('24 APR 1944', 150, ys[3]!, h),
      seg('Colon, right hemicolectomy', 700, ys[3]!, h),
      seg('Received:', 150, ys[4]!, h),
      seg('Consultant:', 700, ys[4]!, h),
      seg('09 JAN 2025', 150, ys[5]!, h),
      seg('Dr. M. Farrukh', 700, ys[5]!, h),
    ];
    expect(asSet(pairsOf(detectFieldGrid(segs, m, 'left')?.blocks))).toEqual(
      new Set([
        'Patient = WHITLOCK, EDITH',
        'Hospital No. = SA-118822',
        'Date of Birth = 24 APR 1944',
        'Specimen = Colon, right hemicolectomy',
        'Received = 09 JAN 2025',
        'Consultant = Dr. M. Farrukh',
      ]),
    );
  });
});

describe('pairing confidence (ordering only — no thresholds)', () => {
  it('every pair carries conf in (0,1]; clean geometry ranks above tight geometry', () => {
    const clean = run(makeGrid({ ...base, boxHeightFrac: 0.7, recordGapRatio: 2.5, labelColon: true, seed: 7 }));
    const tight = run(makeGrid({ ...base, boxHeightFrac: 0.7, recordGapRatio: 1.35, seed: 7 }));
    expect(clean.length).toBeGreaterThan(0);
    expect(tight.length).toBeGreaterThan(0);
    for (const p of [...clean, ...tight]) {
      expect(p.pairConf).toBeDefined();
      expect(p.pairConf!).toBeGreaterThan(0);
      expect(p.pairConf!).toBeLessThanOrEqual(1);
    }
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(clean.map((p) => p.pairConf!))).toBeGreaterThan(mean(tight.map((p) => p.pairConf!)));
  });
});

describe('metric round-trip', () => {
  it('interpreter kv blocks → renderMarkdown → extractKvPairs recovers the expected pairs', () => {
    const g = makeGrid({ ...base, boxHeightFrac: 0.95, recordGapRatio: 2.5, nRecords: 3, seed: 8 });
    const res = detectFieldGrid(g.segs, g.m, 'left');
    const kvOnly = (res?.blocks ?? []).filter((b) => b.kind === 'kv');
    const md = renderMarkdown({ blocks: kvOnly, width: g.pageWidth, height: 400 });
    expect(asSet(extractKvPairs(md))).toEqual(asSet(g.expected));
  });
});

describe('stray-fragment fuzz — pairs never mix records', () => {
  it('noise fragments may corrupt a cell but never create a cross-record pair', () => {
    for (const seed of [11, 12, 13]) {
      const g = makeGrid({ ...base, boxHeightFrac: 0.95, recordGapRatio: 2.5, strayFragments: 3, seed });
      const got = run(g);
      const stripStrays = (t: string) => t.replace(/\s*ZZSTRAY\d+\s*/g, ' ').replace(/\s+/g, ' ').replace(/\s*,\s*$/, '').trim();
      for (const p of got) {
        const label = stripStrays(p.label);
        const value = stripStrays(p.value);
        const lRec = g.roles.get(label)?.record;
        if (lRec === undefined) continue; // label itself was a stray/corrupted beyond recognition
        // Every recognizable fragment of the value must come from the SAME record.
        for (const frag of value.split(', ')) {
          const vRole = g.roles.get(frag.trim());
          if (vRole && vRole.role === 'value') {
            expect(vRole.record, `pair "${p.label} = ${p.value}" mixes records (seed ${seed})`).toBe(lRec);
          }
        }
      }
    }
  });
});
