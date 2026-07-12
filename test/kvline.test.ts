/**
 * Stage 2 — validated line-kv parsing (pairing/kvline.ts), its classify.ts
 * delegation, and Deep Read kv preservation (vlmregion normalize/assemble).
 *
 * The accept cases are shapes the old charset regexes REJECTED on real
 * reports (commas, parens, lowercase label starts); the reject cases are the
 * prose lead-ins and paren fragments the old charsets happened to catch and
 * the validated splitter must keep catching — by structure or semantics, not
 * by character sets.
 */
import { describe, expect, it } from 'vitest';
import { kvSemanticScore, parseKvLine, validKvShape } from '../src/structure/pairing/kvline.ts';
import { parseKvText, splitLead } from '../src/structure/classify.ts';
import { vlmRegionToBlocks } from '../src/structure/vlmregion/normalize.ts';
import { demoteEmptiedKvs } from '../src/structure/vlmregion/assemble.ts';
import type { Block } from '../src/structure/blocks.ts';

const BOX = { x0: 0, y0: 0, x1: 100, y1: 20 };

describe('parseKvLine — strict acceptance', () => {
  const ACCEPT: [string, string, string][] = [
    ['HOSP No: 8433281829', 'HOSP No', '8433281829'],
    [
      'Prostate, biopsy: Acinar adenocarcinoma, Gleason score 3+4=7 (Grade Group 2)',
      'Prostate, biopsy',
      'Acinar adenocarcinoma, Gleason score 3+4=7 (Grade Group 2)',
    ],
    ['Procedure: Partial mastectomy (lumpectomy)', 'Procedure', 'Partial mastectomy (lumpectomy)'],
    // Lowercase label starts are legal now (the old parseKvText required [A-Z]).
    ['pT2: Tumor invades muscularis propria', 'pT2', 'Tumor invades muscularis propria'],
    // Short capitalized values are NORMAL for fields — weak label-shape on the
    // value side is not evidence against the split.
    ['Laterality: Left', 'Laterality', 'Left'],
    ['Sex: Male', 'Sex', 'Male'],
    // Dotted abbreviation labels survive the terminal-punctuation rule.
    ['Hospital No.: 434 257 1829', 'Hospital No.', '434 257 1829'],
    ['Regional Lymph Nodes Examined: 3', 'Regional Lymph Nodes Examined', '3'],
    ['Pathologic Stage (pTNM): pT1c pN0', 'Pathologic Stage (pTNM)', 'pT1c pN0'],
  ];
  it.each(ACCEPT)('accepts %s', (text, label, value) => {
    expect(parseKvLine(text)).toEqual({ isKv: true, label, value });
  });

  const REJECT: string[] = [
    // Terminal colon: a lead-in has no value to bind.
    'Histopathological analysis should include the following:',
    // Prose lead-in with a value-looking tail: the LEFT side is sentence-ish.
    'Histopathological analysis should include the following: margins, grade, and stage',
    // Colon inside an unbalanced paren is quoting prose, not splitting a field.
    'benign (Ref: 12345) adenomas',
    'cases include benign adenomas from 2018 (Ref: 12345)',
    // A clock reading the OCR spaced out.
    'Collected 10: 30 AM',
    // A "Site: finding…" diagnosis whose value runs across a sentence boundary
    // is a paragraph (GT renders these as prose), not a field.
    'Pleural fluid, left, thoracentesis: Positive for malignant cells. Clusters of atypical epithelial cells are present against a reactive background.',
  ];
  it.each(REJECT)('rejects %s', (text) => {
    expect(parseKvLine(text).isKv).toBe(false);
  });

  it('splits at the first ACCEPTED colon, skipping invalid earlier ones', () => {
    // First ": " sits inside an unbalanced paren fragment; the parse must not
    // give up, nor accept the bad split.
    const r = parseKvLine('(see: note) Diagnosis: melanoma in situ');
    expect(r.isKv).toBe(true);
    expect(r.label).toBe('(see: note) Diagnosis');
  });
});

describe('parseKvLine — structure vs semantics', () => {
  it('lenient mode checks structure only (VLM-asserted pairs)', () => {
    const text = 'Histopathological analysis should include the following: margins, grade, and stage';
    expect(parseKvLine(text).isKv).toBe(false);
    expect(parseKvLine(text, { lenient: true }).isKv).toBe(true);
  });

  it('lenient mode still enforces structure', () => {
    expect(parseKvLine('cases include benign adenomas from 2018 (Ref: 12345)', { lenient: true }).isKv).toBe(false);
    expect(parseKvLine('Collected 10: 30 AM', { lenient: true }).isKv).toBe(false);
  });

  it('validKvShape rejects >7-word and sentence-punctuated labels', () => {
    expect(validKvShape('one two three four five six seven eight', 'v')).toBe(false);
    expect(validKvShape('Ends with a comma,', 'v')).toBe(false);
    expect(validKvShape('This label ends a sentence.', 'v')).toBe(false);
    expect(validKvShape('Hospital No.', '999')).toBe(true);
    expect(validKvShape('123 456', 'v')).toBe(false); // no letter
  });

  it('semantic score is above the bar for label→value and below for prose', () => {
    expect(kvSemanticScore('DIAGNOSIS', '02 DEC 1962')).toBeGreaterThan(0.5);
    expect(kvSemanticScore('analysis should include the following', 'margins, grade')).toBeLessThan(0.5);
  });
});

describe('classify.ts delegation', () => {
  it('parseKvText matches parseKvLine verbatim', () => {
    expect(parseKvText('Tumor Size: 18 mm')).toEqual({ isKv: true, label: 'Tumor Size', value: '18 mm' });
    expect(parseKvText('The specimen shows the following: fat').isKv).toBe(false);
  });

  it('splitLead splits validated leads and passes prose through', () => {
    expect(splitLead('Location: Right upper lobe')).toEqual({ lead: 'Location', text: 'Right upper lobe' });
    expect(splitLead('includes the following: a, b')).toEqual({ text: 'includes the following: a, b' });
  });
});

describe('vlm normalize — **Label:** value lines survive mdast', () => {
  it('reads tight kv runs (one mdast paragraph) as kv blocks, order preserved', () => {
    const md = ['Intro line.', '**PATIENT:** ALVAREZ, RAMON', '**MRN**: MR-7781-2240', 'Closing line.'].join('\n');
    const blocks = vlmRegionToBlocks(md, 'text', BOX)!;
    expect(blocks.map((b) => b.kind)).toEqual(['paragraph', 'kv', 'kv', 'paragraph']);
    const kvs = blocks.filter((b): b is Extract<Block, { kind: 'kv' }> => b.kind === 'kv');
    expect(kvs[0]).toMatchObject({ label: 'PATIENT', value: 'ALVAREZ, RAMON' });
    expect(kvs[1]).toMatchObject({ label: 'MRN', value: 'MR-7781-2240' });
  });

  it('is lenient on VLM-asserted pairs (anchoring audits the tokens)', () => {
    const md = '**Long asserted lead label here:** some value';
    const blocks = vlmRegionToBlocks(md, 'text', BOX)!;
    expect(blocks[0]!.kind).toBe('kv');
  });

  it('does not lift bold-label text out of an HTML table', () => {
    const md = ['<table><tr><td>', '**Result:** Positive', '</td></tr></table>'].join('\n');
    const blocks = vlmRegionToBlocks(md, 'text', BOX)!;
    expect(blocks.every((b) => b.kind !== 'kv')).toBe(true);
  });

  it('leaves list items with bold leads to the list path', () => {
    const md = '- **Location:** Right upper lobe';
    const blocks = vlmRegionToBlocks(md, 'text', BOX)!;
    expect(blocks[0]).toMatchObject({ kind: 'listItem', lead: 'Location' });
  });
});

describe('line-kv wrap continuation (SegMerger)', () => {
  const line = (text: string, y: number, x0 = 84): { text: string; conf: number; box: { x0: number; y0: number; x1: number; y1: number } } => ({
    text,
    conf: 0.95,
    box: { x0, y0: y - 7, x1: x0 + text.length * 7, y1: y + 7 },
  });
  const page = (lines: ReturnType<typeof line>[]) => ({ lines, width: 1275, height: 1650, engineId: 'test' });

  it('a next-row same-margin line extends the kv value instead of opening a paragraph', async () => {
    const { buildDocModel } = await import('../src/structure/assemble.ts');
    const doc = buildDocModel(
      page([
        line('Skin, left nasal ala, punch biopsy: Nodular basal cell carcinoma composed of nests of basaloid cells with palisading and retraction artefact,', 100),
        line('extending to a depth of 1.8 mm. Excision margins are not assessable.', 129),
      ]),
      { headings: false },
    );
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]).toMatchObject({
      kind: 'kv',
      label: 'Skin, left nasal ala, punch biopsy',
      value:
        'Nodular basal cell carcinoma composed of nests of basaloid cells with palisading and retraction artefact, extending to a depth of 1.8 mm. Excision margins are not assessable.',
    });
  });

  it('a misaligned next line stays its own paragraph', async () => {
    const { buildDocModel } = await import('../src/structure/assemble.ts');
    const doc = buildDocModel(
      page([
        line('Skin, left nasal ala, punch biopsy: Nodular basal cell carcinoma composed of nests of basaloid cells,', 100),
        line('Complete excision is recommended for this specimen going forward.', 129, 300),
      ]),
      { headings: false },
    );
    expect(doc.blocks.map((b) => b.kind)).toEqual(['kv', 'paragraph']);
  });
});

describe('vlm assemble — anchoring-emptied kv demotes to paragraph', () => {
  it('demotes kv whose value lost every audited token', () => {
    const blocks: Block[] = [
      { kind: 'kv', label: 'CASE NO.', value: '()', box: BOX },
      { kind: 'kv', label: 'PATIENT', value: 'ALVAREZ, RAMON', box: BOX },
    ];
    demoteEmptiedKvs(blocks);
    expect(blocks[0]).toMatchObject({ kind: 'paragraph', text: 'CASE NO.:' });
    expect(blocks[1]!.kind).toBe('kv');
  });
});
