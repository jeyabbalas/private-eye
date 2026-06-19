/**
 * Worklist → document projection (annotate.ts). These pin the rules the Markdown
 * pane relies on: each item attaches to its own block (or the nearest one as an
 * anchor), severity follows the category, only in-block items carry an inline
 * token, an omitted number never marks inline (it isn't in the result), and the
 * book-tab numbers follow worklist order.
 */
import { describe, it, expect } from 'vitest';
import { buildAnnotations, nearestUid, SEVERITY } from '../src/review/annotate.ts';
import type { AttentionItem, AttentionCategory } from '../src/review/attention.ts';
import { baseUid, type WorkingBlock } from '../src/review/corrections.ts';
import type { BBox } from '../src/core/types.ts';

const box = (y0: number, y1 = y0 + 10): BBox => ({ x0: 0, y0, x1: 100, y1 });

const block = (i: number, y0: number): WorkingBlock => ({
  uid: baseUid(i),
  kind: 'paragraph',
  box: box(y0),
  markdown: `block ${i}`,
  added: false,
});

const item = (over: Partial<AttentionItem> & { id: string; category: AttentionCategory }): AttentionItem => ({
  rank: 0,
  score: 0,
  box: box(0),
  lineIds: [],
  title: 't',
  detail: 'd',
  graded: false,
  ...over,
});

describe('buildAnnotations', () => {
  const blocks = [block(0, 0), block(1, 100), block(2, 200)];

  it('attaches an item to its own block and carries the inline token', () => {
    const anns = buildAnnotations(
      [item({ id: 'conflict:0', category: 'conflict', blockIndex: 1, token: '42', box: box(100) })],
      blocks,
    );
    expect(anns).toHaveLength(1);
    expect(anns[0]).toMatchObject({ id: 'conflict:0', uid: baseUid(1), inThisBlock: true, token: '42', number: 1 });
  });

  it('anchors a block-less item to the nearest block and marks nothing inline', () => {
    const anns = buildAnnotations([item({ id: 'gap:0', category: 'coverage-gap', box: box(150) })], blocks);
    expect(anns[0]!.inThisBlock).toBe(false);
    expect(anns[0]!.uid).toBe(baseUid(1)); // last block starting above y=150
    expect(anns[0]!.token).toBeUndefined();
  });

  it('anchors an item whose block index is missing from the working set', () => {
    const anns = buildAnnotations([item({ id: 'x', category: 'low-block', blockIndex: 9, box: box(250) })], blocks);
    expect(anns[0]!.inThisBlock).toBe(false);
    expect(anns[0]!.uid).toBe(baseUid(2));
  });

  it('never marks an omitted number inline even when it has a token', () => {
    const anns = buildAnnotations(
      [item({ id: 'omit:0', category: 'omitted-number', blockIndex: 0, token: '7', box: box(0) })],
      blocks,
    );
    // omitted has no real blockIndex link in practice, but guard regardless:
    expect(anns[0]!.token).toBeUndefined();
  });

  it('maps severity by category and numbers items in worklist order', () => {
    const anns = buildAnnotations(
      [
        item({ id: 'a', category: 'conflict', blockIndex: 0, box: box(0) }),
        item({ id: 'b', category: 'low-block', blockIndex: 1, box: box(100) }),
      ],
      blocks,
    );
    expect(anns.map((a) => a.number)).toEqual([1, 2]);
    expect(anns[0]!.severity).toBe('attention');
    expect(anns[1]!.severity).toBe('caution');
  });

  it('drops everything when there are no blocks to anchor to', () => {
    expect(buildAnnotations([item({ id: 'a', category: 'conflict' })], [])).toEqual([]);
  });
});

describe('nearestUid', () => {
  const blocks = [block(0, 0), block(1, 100), block(2, 200)];

  it('returns the last block starting at or above the region', () => {
    expect(nearestUid(blocks, box(150))).toBe(baseUid(1));
    expect(nearestUid(blocks, box(200))).toBe(baseUid(2));
  });

  it('falls back to the first block for a region above everything', () => {
    expect(nearestUid([block(0, 50), block(1, 100)], box(0))).toBe(baseUid(0));
  });

  it('returns null with no blocks', () => {
    expect(nearestUid([], box(0))).toBeNull();
  });
});

describe('SEVERITY', () => {
  it('treats categorical/safety categories as red and graded ones as amber', () => {
    expect(SEVERITY.conflict).toBe('attention');
    expect(SEVERITY['unverified-number']).toBe('attention');
    expect(SEVERITY['coverage-gap']).toBe('attention');
    expect(SEVERITY['low-line']).toBe('caution');
    expect(SEVERITY['advisory-word']).toBe('caution');
  });
});
