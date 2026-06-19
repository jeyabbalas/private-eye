/**
 * Numeric anchoring — Pipeline G's safety core. The NumberPool is a consume-once
 * multiset of OCR numeric tokens; anchorText audits each VLM numeric against it
 * under the production 'replace' policy: exact agreement is kept silently, an
 * edit-1 near-miss is swapped to the OCR reading (high-severity event), a clean
 * miss is dropped (high-severity), and a re-segmentation is a low-severity heads-up.
 * These tests pin the consume-once semantics and the per-outcome review events.
 */
import { describe, it, expect } from 'vitest';
import { NumberPool, anchorText, emptyAnchorStats } from '../src/structure/vlmregion/anchor.ts';
import type { ExportLine } from '../src/structure/vlmregion/replay.ts';

const BOX = { x0: 0, y0: 0, x1: 0, y1: 0 };
const line = (text: string): ExportLine => ({ text, conf: 1, box: BOX });
const region = (index: number, ...texts: string[]): { index: number; lines: ExportLine[] } => ({
  index,
  lines: texts.map(line),
});
const ctx = { box: BOX, field: 'text' as const };

describe('NumberPool.takeExact', () => {
  it('consumes each exact match once (multiset, not set)', () => {
    const pool = new NumberPool([region(0, '42 42')], []);
    expect(pool.takeExact('42', 0)).toBe(true);
    expect(pool.takeExact('42', 0)).toBe(true); // the second copy
    expect(pool.takeExact('42', 0)).toBe(false); // exhausted
  });

  it('falls back page-wide when the requested region has no copy', () => {
    const pool = new NumberPool([region(0, 'no digits here'), region(1, '99')], []);
    expect(pool.takeExact('99', 0)).toBe(true); // found in region 1
    expect(pool.takeExact('99', 0)).toBe(false);
  });
});

describe('NumberPool.takeSplitJoin', () => {
  it('joins two adjacent tokens by concatenation', () => {
    const pool = new NumberPool([region(0, '3', '5')], []);
    expect(pool.takeSplitJoin('35', 0)).toEqual({ a: '3', b: '5' });
  });

  it('joins a tightened spaced range via a single separator char', () => {
    const pool = new NumberPool([region(0, '12.0', '15.5')], []);
    expect(pool.takeSplitJoin('12.0-15.5', 0)).toEqual({ a: '12.0', b: '15.5' });
  });

  it('allows a join across one already-consumed neighbor (order gap == 2)', () => {
    const pool = new NumberPool([region(0, '3', '9', '5')], []);
    pool.takeExact('9', 0);
    expect(pool.takeSplitJoin('35', 0)).toEqual({ a: '3', b: '5' });
  });

  it('rejects a join when the surviving tokens were far apart (order gap > 2)', () => {
    const pool = new NumberPool([region(0, '3', '9', '9', '5')], []);
    pool.takeExact('9', 0);
    pool.takeExact('9', 0);
    // 3 (order 0) and 5 (order 3) are all that remain, but their original gap is 3
    expect(pool.takeSplitJoin('35', 0)).toBeNull();
  });
});

describe('NumberPool.takeEdit1', () => {
  it('returns the unique edit-1 OCR reading and consumes it', () => {
    const pool = new NumberPool([region(0, '123')], []);
    expect(pool.takeEdit1('124', 0)).toEqual({ ocr: '123' });
    expect(pool.takeEdit1('124', 0)).toBeNull(); // consumed
  });

  it('is ambiguous when two distinct tokens are each within edit-1', () => {
    const pool = new NumberPool([region(0, '123', '125')], []);
    expect(pool.takeEdit1('124', 0)).toBe('ambiguous'); // 124 ~ 123 and ~ 125
  });

  it('returns null when nothing is within edit-1', () => {
    const pool = new NumberPool([region(0, '999')], []);
    expect(pool.takeEdit1('123', 0)).toBeNull();
  });
});

describe('anchorText (replace policy)', () => {
  it('keeps an exact match and emits no review event', () => {
    const pool = new NumberPool([region(0, '42')], []);
    const stats = emptyAnchorStats();
    const out = anchorText('value is 42', 0, pool, 'replace', stats, ctx);
    expect(out).toBe('value is 42');
    expect(stats.exact).toBe(1);
    expect(stats.events).toHaveLength(0);
  });

  it('swaps an edit-1 misread to the OCR reading with a high-severity replaced event', () => {
    const pool = new NumberPool([region(0, '123')], []);
    const stats = emptyAnchorStats();
    const out = anchorText('reads 124', 0, pool, 'replace', stats, ctx);
    expect(out).toBe('reads 123');
    expect(stats.replaced).toEqual([{ vlm: '124', ocr: '123' }]);
    expect(stats.events).toHaveLength(1);
    expect(stats.events[0]).toMatchObject({
      kind: 'replaced',
      ocrReading: '123',
      vlmReading: '124',
      severity: 'high',
    });
  });

  it('drops an unmatched number with a zero-width caret and a high-severity dropped event', () => {
    const pool = new NumberPool([region(0, '123')], []); // nothing near 9999
    const stats = emptyAnchorStats();
    const out = anchorText('ghost 9999 here', 0, pool, 'replace', stats, ctx);
    expect(out).toBe('ghost here'); // cleanup collapses the gap
    expect(stats.dropped).toEqual(['9999']);
    expect(stats.events).toHaveLength(1);
    const ev = stats.events[0]!;
    expect(ev.kind).toBe('dropped');
    expect(ev.ocrReading).toBeNull();
    expect(ev.vlmReading).toBe('9999');
    expect(ev.charStart).toBe(ev.charEnd); // zero-width span for a removed token
    expect(ev.severity).toBe('high');
  });

  it('emits a low-severity split-joined event for an OCR-attested re-segmentation', () => {
    const pool = new NumberPool([region(0, '3', '5')], []);
    const stats = emptyAnchorStats();
    const out = anchorText('total 35', 0, pool, 'replace', stats, ctx);
    expect(out).toBe('total 35');
    expect(stats.splitJoined).toBe(1);
    expect(stats.events).toHaveLength(1);
    expect(stats.events[0]).toMatchObject({ kind: 'split-joined', severity: 'low' });
  });

  it('leaves text verbatim and audits nothing under the off policy', () => {
    const pool = new NumberPool([], []);
    const stats = emptyAnchorStats();
    expect(anchorText('untouched 999', 0, pool, 'off', stats)).toBe('untouched 999');
    expect(stats.total).toBe(0);
    expect(stats.events).toHaveLength(0);
  });
});
