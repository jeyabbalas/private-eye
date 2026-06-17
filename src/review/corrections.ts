/**
 * Reversible, event-sourced corrections. The base read is the source of truth;
 * user edits are an ordered log of events replayed over it to produce the working
 * document. Because we never mutate the base, every edit is undoable and the log
 * is what we persist (replayed verbatim on reopen).
 *
 * Each base block gets a STABLE uid (`b<index>`) so region add/delete survive
 * index drift, and drawn regions (Phase 4) get their own uids. Blocks are carried
 * as Markdown FRAGMENTS rather than re-parsed structure, so an edit is just "this
 * block's Markdown is now X" — and re-joining the fragments reproduces the
 * pristine serializer's output byte-for-byte when nothing was edited.
 */
import type { Block } from '../structure/blocks.ts';
import type { BBox } from '../core/types.ts';

export interface WorkingBlock {
  uid: string;
  kind: Block['kind'];
  /** Page-pixel box for overlay linking. */
  box: BBox;
  /** Current Markdown for this block (edited, or derived from the base). */
  markdown: string;
  /** True for user-drawn region blocks (Phase 4); false for model blocks. */
  added: boolean;
}

export type CorrectionEvent =
  | { kind: 'text-edit'; uid: string; markdown: string }
  | { kind: 'block-remove'; uid: string }
  | {
      kind: 'region-add';
      uid: string;
      /** Insert immediately after this uid; null prepends at the very start (a
       *  region drawn above every existing block). */
      afterUid: string | null;
      blockKind: Block['kind'];
      markdown: string;
      box: BBox;
    }
  | { kind: 'dismiss'; targetId: string };

export const baseUid = (index: number): string => `b${index}`;

function renderTable(cells: string[][]): string {
  if (!cells.length) return '';
  const cols = Math.max(...cells.map((r) => r.length));
  const pad = (row: string[]): string[] => {
    const r = [...row];
    while (r.length < cols) r.push('');
    return r;
  };
  const head = pad(cells[0]!);
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of cells.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  return lines.join('\n');
}

/**
 * Per-block Markdown — mirrors the pristine `renderMarkdown` switch (kept as a
 * review-layer copy so the serializer in structure/blocks.ts stays untouched).
 */
export function blockToMarkdown(b: Block): string {
  switch (b.kind) {
    case 'heading':
      return `${'#'.repeat(b.depth)} ${b.text}`;
    case 'paragraph':
      return b.text;
    case 'listItem':
      return `- ${b.lead ? `**${b.lead}:** ` : ''}${b.text}`;
    case 'kv':
      return `**${b.label}:** ${b.value}`;
    case 'table':
      return renderTable(b.cells);
    case 'rule':
      return '---';
  }
}

/** Seed working blocks from the base read (no events applied yet). */
export function seedWorkingBlocks(baseBlocks: Block[]): WorkingBlock[] {
  return baseBlocks.map((b, i) => ({
    uid: baseUid(i),
    kind: b.kind,
    box: b.box,
    markdown: blockToMarkdown(b),
    added: false,
  }));
}

/** Replay the correction log over the base read to get the working document. */
export function applyCorrections(baseBlocks: Block[], events: readonly CorrectionEvent[]): WorkingBlock[] {
  const blocks = seedWorkingBlocks(baseBlocks);
  const removed = new Set<string>();
  for (const ev of events) {
    switch (ev.kind) {
      case 'text-edit': {
        const wb = blocks.find((b) => b.uid === ev.uid);
        if (wb) wb.markdown = ev.markdown;
        break;
      }
      case 'block-remove':
        removed.add(ev.uid);
        break;
      case 'region-add': {
        const wb: WorkingBlock = { uid: ev.uid, kind: ev.blockKind, box: ev.box, markdown: ev.markdown, added: true };
        if (ev.afterUid === null) {
          blocks.unshift(wb); // drawn above everything → first
        } else {
          const idx = blocks.findIndex((b) => b.uid === ev.afterUid);
          if (idx >= 0) blocks.splice(idx + 1, 0, wb);
          else blocks.push(wb); // anchor since removed → append as a safe fallback
        }
        break;
      }
      case 'dismiss':
        break; // affects the attention queue, not the document
    }
  }
  return blocks.filter((b) => !removed.has(b.uid));
}

/**
 * Join working blocks back into Markdown using the same spacing rule as the
 * pristine serializer (blank line between blocks; adjacent kv/list kept tight),
 * so an unedited document round-trips byte-for-byte.
 */
export function renderWorkingMarkdown(blocks: readonly WorkingBlock[]): string {
  const out: string[] = [];
  let prevKind: Block['kind'] | null = null;
  for (const b of blocks) {
    const tight = (b.kind === 'kv' && prevKind === 'kv') || (b.kind === 'listItem' && prevKind === 'listItem');
    if (out.length && !tight) out.push('');
    out.push(b.markdown);
    prevKind = b.kind;
  }
  return out.join('\n') + '\n';
}

/** Attention targets the user explicitly dismissed (kept out of the worklist). */
export function dismissedIds(events: readonly CorrectionEvent[]): Set<string> {
  const s = new Set<string>();
  for (const ev of events) if (ev.kind === 'dismiss') s.add(ev.targetId);
  return s;
}

/** Cheap stable hash of the base read, stored with the corrections to detect a
 *  re-read that invalidates index-based uids (djb2 over the serialized blocks). */
export function baseHash(blocks: Block[]): string {
  const s = JSON.stringify(blocks);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
