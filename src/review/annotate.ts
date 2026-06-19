/**
 * Project the attention worklist onto the working document. Pure mapping (no DOM):
 * each flagged item is tied to the block it belongs to — or, for a region-level
 * item with no block, the nearest block as an anchor — and tagged with a severity
 * and, when the item owns a token in that block, the substring to highlight inline.
 * The Markdown editor turns these into inline marks + numbered book-tabs.
 */
import type { BBox } from '../core/types.ts';
import type { AttentionCategory, AttentionItem } from './attention.ts';
import { baseUid, type WorkingBlock } from './corrections.ts';
import type { BlockAnnotation } from './markdown-editor.ts';

/** Red (categorical / safety) vs amber (graded) per worklist category. */
export const SEVERITY: Record<AttentionCategory, 'attention' | 'caution'> = {
  conflict: 'attention',
  'unverified-number': 'attention',
  'omitted-number': 'attention',
  'coverage-gap': 'attention',
  'low-block': 'caution',
  'low-line': 'caution',
  'advisory-word': 'caution',
};

export function buildAnnotations(items: readonly AttentionItem[], blocks: readonly WorkingBlock[]): BlockAnnotation[] {
  const uids = new Set(blocks.map((b) => b.uid));
  const out: BlockAnnotation[] = [];
  items.forEach((it, i) => {
    const realUid = it.blockIndex != null && it.blockIndex >= 0 ? baseUid(it.blockIndex) : null;
    const inThisBlock = realUid != null && uids.has(realUid);
    const uid = inThisBlock ? realUid! : nearestUid(blocks, it.box);
    if (!uid) return;
    out.push({
      id: it.id,
      number: i + 1,
      uid,
      severity: SEVERITY[it.category],
      inThisBlock,
      // An omitted number isn't in the result, so there's nothing to mark inline.
      token: inThisBlock && it.category !== 'omitted-number' ? it.token : undefined,
    });
  });
  return out;
}

/** The block a region best belongs to: the last one starting above it, else the
 *  first (so a region-level flag still gets a tab near where it sits). */
export function nearestUid(blocks: readonly WorkingBlock[], box: BBox): string | null {
  if (!blocks.length) return null;
  let uid = blocks[0]!.uid;
  for (const b of blocks) if (b.box.y0 <= box.y0) uid = b.uid;
  return uid;
}
