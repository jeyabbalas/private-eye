import { describe, expect, it } from 'vitest';
import {
  extractKvPairs,
  familyOf,
  gtNeutralBindings,
  inferKind,
  kvPairsFromBlocks,
  labelsMatch,
  leaveOneFamilyOut,
  rates,
  scorePagePairing,
  sumCounts,
  twoColTableRows,
  valuesMatch,
  type GtField,
} from '../src/eval/pairing.ts';
import { renderMarkdown } from '../src/structure/blocks.ts';
import type { Block } from '../src/structure/blocks.ts';

const BOX = { x0: 0, y0: 0, x1: 10, y1: 10 };
const kv = (label: string, value: string): Block => ({ kind: 'kv', label, value, box: BOX });
const para = (text: string): Block => ({ kind: 'paragraph', text, box: BOX });

const GT = `# CENTRAL PATHOLOGY

**Bold banner without a value**

**Patient:** ALVAREZ, RAMON
**MRN:** MR-7781-2240
**Date of Birth:** 11 FEB 1968

- **Location:** Right-side soft tissue

| Feature | Detail |
| --- | --- |
| Site | Caecum |
`;

describe('extractKvPairs', () => {
  it('extracts only line-anchored **Label:** value lines', () => {
    expect(extractKvPairs(GT)).toEqual([
      { label: 'Patient', value: 'ALVAREZ, RAMON' },
      { label: 'MRN', value: 'MR-7781-2240' },
      { label: 'Date of Birth', value: '11 FEB 1968' },
    ]);
  });

  it('keeps duplicate labels distinct', () => {
    const md = '**Grade:** 2\n**Grade:** 3\n';
    expect(extractKvPairs(md)).toHaveLength(2);
  });

  it('collects bullet leads and 2-col table rows as neutral bindings', () => {
    const n = gtNeutralBindings(GT);
    expect(n).toContainEqual({ label: 'Location', value: 'Right-side soft tissue' });
    expect(n).toContainEqual({ label: 'Site', value: 'Caecum' });
    expect(n).toContainEqual({ label: 'Feature', value: 'Detail' }); // header rows count as bindings too
  });
});

describe('renderMarkdown ↔ extractKvPairs round-trip', () => {
  it('recovers exactly the kv blocks', () => {
    const blocks: Block[] = [
      { kind: 'heading', depth: 1, text: 'TITLE', box: BOX },
      kv('Patient', 'ALVAREZ, RAMON'),
      kv('Sex', 'Male'),
      { kind: 'listItem', lead: 'Location', text: 'Right side', box: BOX },
      { kind: 'table', cells: [['A', 'B'], ['1', '2']], box: BOX },
      para('Some paragraph text.'),
    ];
    const md = renderMarkdown({ blocks, width: 100, height: 100 });
    expect(extractKvPairs(md)).toEqual([
      { label: 'Patient', value: 'ALVAREZ, RAMON' },
      { label: 'Sex', value: 'Male' },
    ]);
  });
});

describe('matchers', () => {
  it('labels: token count strict, edit-1 forgiving, trailing colon/period stripped', () => {
    expect(labelsMatch('Date of Birth', 'DATE OF BIRTH:')).toBe(true);
    expect(labelsMatch('Hospital No.', 'Hospital No')).toBe(true);
    expect(labelsMatch('Patient', 'Patiend')).toBe(true); // one OCR misread
    expect(labelsMatch('Patient', 'Patient Name')).toBe(false); // token count differs
    expect(labelsMatch('ELIZABETH SMITH', 'MEDICAL WARD')).toBe(false);
  });

  it('values: kind-aware normalization', () => {
    expect(valuesMatch('434 257 1829', '434 257 1829', 'id')).toBe(true);
    expect(valuesMatch('434 257 1829', '4342571829', 'id')).toBe(true); // id folding
    expect(valuesMatch('11 FEB 1968', '11 Feb 1968', 'date')).toBe(true);
    expect(valuesMatch('Male', 'Female', 'text')).toBe(false);
    expect(valuesMatch('3', '0', 'text')).toBe(false); // short tokens are exact — no edit-1 laxity
    expect(valuesMatch('3', '3', 'text')).toBe(true);
    // wrapped multi-line value joined with doubled commas still matches (edge punct trimmed)
    expect(valuesMatch('ELIZABETH SMITH, MEDICAL WARD, USA', 'ELIZABETH SMITH,, MEDICAL WARD,, USA', 'text')).toBe(true);
  });

  it('inferKind: fields.json tags the kind and criticality', () => {
    const fields: GtField[] = [{ name: 'mrn', value: 'MR-7781-2240', normalize: 'id', page: 1 }];
    expect(inferKind('MR-7781-2240', fields)).toEqual({ kind: 'id', critical: true });
    expect(inferKind('Male', fields)).toEqual({ kind: 'text', critical: false });
  });
});

describe('scorePagePairing', () => {
  const gt = '**Patient:** ALVAREZ, RAMON\n**MRN:** MR-7781-2240\n**Sex:** Male\n**Collected:** 03 APR 2024\n';
  const fields: GtField[] = [{ name: 'mrn', value: 'MR-7781-2240', normalize: 'id', page: 1 }];

  it('all paired → recall 1, precision 1, empty buckets', () => {
    const blocks = [kv('Patient', 'ALVAREZ, RAMON'), kv('MRN', 'MR-7781-2240'), kv('Sex', 'Male'), kv('Collected', '03 APR 2024')];
    const s = scorePagePairing(gt, blocks, fields);
    expect(s.tp).toBe(4);
    expect(s.fp).toBe(0);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.mispaired + s.inTable + s.inList + s.unpaired + s.ocrMiss).toBe(0);
    expect(s.criticalRecall).toBe(1);
  });

  it('value under a wrong label → mispaired (+ FP for the wrong pair)', () => {
    const blocks = [kv('Patient', 'ALVAREZ, RAMON'), kv('Sex', 'MR-7781-2240')];
    const s = scorePagePairing(gt, blocks, fields);
    expect(s.tp).toBe(1);
    expect(s.mispaired).toBe(1); // MRN's value bound under "Sex"
    expect(s.fp).toBe(1);
    expect(s.criticalRecall).toBe(0);
  });

  it('binding preserved as 2-col table row → inTable, counted by bindingRecall', () => {
    const blocks: Block[] = [
      kv('Patient', 'ALVAREZ, RAMON'),
      { kind: 'table', cells: [['MRN', 'MR-7781-2240'], ['Sex', 'Male'], ['Collected', '03 APR 2024']], box: BOX },
    ];
    const s = scorePagePairing(gt, blocks, fields);
    expect(s.tp).toBe(1);
    expect(s.inTable).toBe(3);
    expect(s.bindingRecall).toBe(1);
    expect(s.recall).toBe(0.25);
  });

  it('binding preserved as a list-item lead → inList, counted by bindingRecall', () => {
    const blocks: Block[] = [
      kv('Patient', 'ALVAREZ, RAMON'),
      { kind: 'listItem', lead: 'MRN', text: 'MR-7781-2240', box: BOX },
      { kind: 'listItem', lead: 'Sex', text: 'Male', box: BOX },
      { kind: 'listItem', lead: 'Collected', text: '03 APR 2024', box: BOX },
    ];
    const s = scorePagePairing(gt, blocks, fields);
    expect(s.tp).toBe(1);
    expect(s.inList).toBe(3);
    expect(s.bindingRecall).toBe(1);
  });

  it('emitted kv matching a GT plain "Label: value" paragraph is precision-neutral', () => {
    const gtPlain = '**Patient:** ALVAREZ, RAMON\n\nReported by: Dr. T. Vasquez, Consultant\n';
    const s = scorePagePairing(gtPlain, [kv('Patient', 'ALVAREZ, RAMON'), kv('Reported by', 'Dr. T. Vasquez, Consultant')], []);
    expect(s.fp).toBe(0);
    expect(s.tp).toBe(1);
  });

  it('value present but bound nowhere → unpaired; absent from pool → ocrMiss', () => {
    const blocks = [para('ALVAREZ, RAMON'), para('MR-7781-2240 Male')];
    const s = scorePagePairing(gt, blocks, fields);
    const by = Object.fromEntries(s.outcomes.map((o) => [o.gt.label, o.outcome]));
    expect(by['Patient']).toBe('unpaired');
    expect(by['MRN']).toBe('unpaired');
    expect(by['Sex']).toBe('unpaired');
    expect(by['Collected']).toBe('ocrMiss');
  });

  it('emitted kv matching a GT bullet lead or table row is precision-neutral', () => {
    const gtWithBullet = '**Patient:** ALVAREZ, RAMON\n\n- **Location:** Right-side soft tissue\n';
    const blocks = [kv('Patient', 'ALVAREZ, RAMON'), kv('Location', 'Right-side soft tissue')];
    const s = scorePagePairing(gtWithBullet, blocks, []);
    expect(s.fp).toBe(0);
    expect(s.tp).toBe(1);
  });

  it('duplicate labels bind one-to-one in reading order', () => {
    const gtDup = '**Grade:** 2\n**Grade:** 3\n';
    const s = scorePagePairing(gtDup, [kv('Grade', '2'), kv('Grade', '3')], []);
    expect(s.tp).toBe(2);
    const sMissing = scorePagePairing(gtDup, [kv('Grade', '3')], []);
    expect(sMissing.tp).toBe(1);
  });
});

describe('aggregation', () => {
  it('rates derive from summed counts; LOLO holds out one family', () => {
    const a = scorePagePairing('**A:** 1\n**B:** 2\n', [kv('A', '1'), kv('B', '2')], []);
    const b = scorePagePairing('**C:** 3\n', [kv('C', 'zzz')], []);
    const per = { 'doc1.001': a, 'doc1.002': b, 'doc2.001': a };
    const total = sumCounts(Object.values(per));
    expect(total.gtPairs).toBe(5);
    expect(rates(total).recall).toBeCloseTo(4 / 5);

    const lolo = leaveOneFamilyOut(per);
    expect(lolo.map((l) => l.heldOut)).toEqual(['doc1', 'doc2']);
    const holdDoc1 = lolo.find((l) => l.heldOut === 'doc1')!;
    expect(holdDoc1.counts.gtPairs).toBe(2); // only doc2 remains
    expect(holdDoc1.rates.recall).toBe(1);
    expect(familyOf('sample1.002')).toBe('sample1');
  });
});
