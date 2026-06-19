/**
 * Pipeline V — the runtime verbatim-coverage gate. Numerics are the hard gate
 * (any fabricated or any above-confidence omitted number => 'fallback'); word
 * rates are advisory ('review'). A one-digit OCR misread is forgiven (edit-1, it's
 * CER not invention), low-confidence OCR is excluded from the omission check, and a
 * numeric the anchor already surfaced is not double-counted. These tests pin that
 * decision logic and the provenance the audit UI relies on.
 */
import { describe, it, expect } from 'vitest';
import { verifyPage } from '../src/structure/verify.ts';
import type { Block, DocModel } from '../src/structure/blocks.ts';
import type { OcrLine, OcrResult } from '../src/core/types.ts';
import type { UncertaintyLayer } from '../src/structure/uncertainty.ts';

const BOX = { x0: 0, y0: 0, x1: 0, y1: 0 };
const para = (text: string): Block => ({ kind: 'paragraph', text, box: BOX });
const doc = (...blocks: Block[]): DocModel => ({ blocks, width: 100, height: 100 });
const ocrLine = (text: string, conf = 1): OcrLine => ({ text, conf, box: BOX });
const ocr = (...lines: OcrLine[]): OcrResult => ({ lines, width: 100, height: 100, engineId: 'test' });

describe('verifyPage', () => {
  it('passes when every output token is OCR-attested', () => {
    const r = verifyPage({
      doc: doc(para('weight 70 kg height 180 cm')),
      ocr: ocr(ocrLine('weight 70 kg height 180 cm')),
    });
    expect(r.verdict).toBe('pass');
    expect(r.fabrication.numbers).toHaveLength(0);
    expect(r.omission.numbers).toHaveLength(0);
  });

  it('falls back on a fabricated number (present in the output, never in the scan)', () => {
    const r = verifyPage({
      doc: doc(para('dose 250 mg twice 500')),
      ocr: ocr(ocrLine('dose 250 mg twice')),
    });
    expect(r.fabrication.numbers.map((f) => f.token)).toEqual(['500']);
    expect(r.omission.numbers).toHaveLength(0);
    expect(r.verdict).toBe('fallback');
  });

  it('forgives a one-digit OCR misread (edit-1) as CER, not fabrication or omission', () => {
    const r = verifyPage({
      doc: doc(para('total 1234')),
      ocr: ocr(ocrLine('total 1235')),
    });
    expect(r.fabrication.numbers).toHaveLength(0);
    expect(r.omission.numbers).toHaveLength(0);
    expect(r.verdict).toBe('pass');
  });

  it('excludes low-confidence OCR numbers from the omission check', () => {
    const r = verifyPage({
      doc: doc(para('numbers in body')),
      ocr: ocr(ocrLine('numbers in body 555', 0.3)), // 555 seen, but below minOcrConf 0.5
    });
    expect(r.omission.numbers).toHaveLength(0);
    expect(r.verdict).toBe('pass');
  });

  it('falls back on a number the OCR read confidently but the output dropped', () => {
    const r = verifyPage({
      doc: doc(para('numbers in body')),
      ocr: ocr(ocrLine('numbers in body 555', 0.95)),
    });
    expect(r.omission.numbers.map((f) => f.token)).toContain('555');
    expect(r.verdict).toBe('fallback');
  });

  it('flags an un-anchored numeric as fabrication...', () => {
    const r = verifyPage({
      doc: doc(para('code 404 value 200')),
      ocr: ocr(ocrLine('code value 200')),
    });
    expect(r.fabrication.numbers.map((f) => f.token)).toContain('404');
    expect(r.verdict).toBe('fallback');
  });

  it('...but does NOT double-count it once the anchor has surfaced it (reviewItems)', () => {
    const uncertainty: UncertaintyLayer = {
      schema: 'uncertainty/1',
      width: 100,
      height: 100,
      calibration: 'identity',
      lines: [],
      coverageGaps: [],
      blocks: [],
      reviewItems: [
        {
          kind: 'dropped',
          regionIndex: 0,
          blockIndex: 0,
          box: BOX,
          charStart: 0,
          charEnd: 0,
          ocrReading: null,
          vlmReading: '404',
          severity: 'high',
        },
      ],
      tableStructureConfidence: null,
    };
    const r = verifyPage({
      doc: doc(para('code 404 value 200')),
      ocr: ocr(ocrLine('code value 200')),
      uncertainty,
    });
    expect(r.fabrication.numbers).toHaveLength(0); // 404 already surfaced -> not re-reported
    expect(r.verdict).toBe('pass');
  });

  it('returns an advisory review verdict on a high word-fabrication rate (numbers clean)', () => {
    const r = verifyPage({
      doc: doc(para('alpha bravo charlie delta echo foxtrot')),
      ocr: ocr(ocrLine('alpha bravo')), // charlie..foxtrot absent from the scan
    });
    expect(r.fabrication.numbers).toHaveLength(0);
    expect(r.omission.numbers).toHaveLength(0);
    expect(r.verdict).toBe('review');
  });

  it('attributes fabrication to its block index and omission to its OCR line ids', () => {
    const r = verifyPage({
      doc: doc(para('first block'), para('second 777 block')),
      ocr: ocr(ocrLine('first block'), ocrLine('second block 888')),
    });
    expect(r.fabrication.numbers.find((f) => f.token === '777')?.blockIndex).toBe(1);
    expect(r.omission.numbers.find((f) => f.token === '888')?.lineIds).toEqual([1]);
    expect(r.verdict).toBe('fallback');
  });
});
