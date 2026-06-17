/**
 * Numeric anchoring — Pipeline G's safety core (NEXT_PIPELINES §G: "numeric
 * tokens that disagree are replaced by OCR's reading and/or flagged… the VLM
 * contributes structure and hard-glyph reading, never unaudited numbers").
 *
 * A page-scoped consume-once multiset of OCR numeric tokens (same extractor as
 * the fabrication/omission metrics) audits every numeric token in VLM-derived
 * blocks. Policy:
 *   - 'replace': unanchored tokens are REMOVED from the text and unique
 *     near-miss (edit-1) tokens are swapped to the OCR reading — output then
 *     contains only OCR-attested numerics by construction;
 *   - 'flag': nothing is rewritten; mismatches are recorded (stats/note only —
 *     no inline markers, which would pollute CER/fabrication scoring);
 *   - 'off': no auditing (raw VLM, the fabrication-rate ablation).
 */
import { distance } from 'fastest-levenshtein';
import { extractNumbers } from '../../eval/normalize.ts';
import type { BBox } from '../../core/types.ts';
import type { Block } from '../blocks.ts';
import type { ReviewItem, ReviewKind } from '../uncertainty.ts';
import type { ExportLine } from './replay.ts';

export type AnchorPolicy = 'replace' | 'flag' | 'off';

export interface AnchorStats {
  total: number;
  exact: number;
  splitJoined: number;
  replaced: { vlm: string; ocr: string }[];
  dropped: string[];
  flagged: string[];
  ambiguous: string[];
  /** Provenance-carrying disagreement records for the uncertainty layer (the
   *  app's review queue). One per non-exact numeric token; see anchorText. */
  events: ReviewItem[];
}

export const emptyAnchorStats = (): AnchorStats => ({
  total: 0,
  exact: 0,
  splitJoined: 0,
  replaced: [],
  dropped: [],
  flagged: [],
  ambiguous: [],
  events: [],
});

export function mergeAnchorStats(into: AnchorStats, from: AnchorStats): void {
  into.total += from.total;
  into.exact += from.exact;
  into.splitJoined += from.splitJoined;
  into.replaced.push(...from.replaced);
  into.dropped.push(...from.dropped);
  into.flagged.push(...from.flagged);
  into.ambiguous.push(...from.ambiguous);
  into.events.push(...from.events);
}

interface PoolEntry {
  token: string;
  region: number; // region index; -1 = orphan lines
  order: number; // stable order within the page (line order)
  consumed: boolean;
}

export class NumberPool {
  private entries: PoolEntry[] = [];

  constructor(regions: { index: number; lines: ExportLine[] }[], orphans: ExportLine[]) {
    let order = 0;
    for (const r of regions) {
      for (const line of r.lines) for (const tok of extractNumbers(line.text)) this.entries.push({ token: tok, region: r.index, order: order++, consumed: false });
    }
    for (const line of orphans) for (const tok of extractNumbers(line.text)) this.entries.push({ token: tok, region: -1, order: order++, consumed: false });
  }

  private available(region?: number): PoolEntry[] {
    return this.entries.filter((e) => !e.consumed && (region === undefined || e.region === region));
  }

  /** Exact unconsumed match, same region preferred, else page-wide. */
  takeExact(tok: string, region: number): boolean {
    const hit = this.available(region).find((e) => e.token === tok) ?? this.available().find((e) => e.token === tok);
    if (hit) hit.consumed = true;
    return !!hit;
  }

  /** Two ADJACENT unconsumed same-region entries whose concatenation (optionally
   *  with one separator char) equals tok — an OCR det split like "3"+"5"="3.5",
   *  or a VLM compression of a printed spaced range "12.0 - 15.5"→"12.0-15.5". */
  takeSplitJoin(tok: string, region: number): { a: string; b: string } | null {
    const avail = this.available(region).sort((a, b) => a.order - b.order);
    for (let i = 0; i + 1 < avail.length; i++) {
      const a = avail[i]!;
      const b = avail[i + 1]!;
      if (b.order - a.order > 2) continue; // adjacency in line order
      if (a.token + b.token === tok || (tok.startsWith(a.token) && tok.endsWith(b.token) && tok.length === a.token.length + b.token.length + 1)) {
        a.consumed = true;
        b.consumed = true;
        return { a: a.token, b: b.token };
      }
    }
    return null;
  }

  /** Unique edit-1 candidate (distinct token VALUES), same region first then
   *  page-wide. Returns the OCR reading, or null (none/ambiguous → `ambiguous`). */
  takeEdit1(tok: string, region: number): { ocr: string } | 'ambiguous' | null {
    for (const scope of [region, undefined] as const) {
      const cands = this.available(scope).filter((e) => Math.abs(e.token.length - tok.length) <= 1 && distance(e.token, tok) <= 1);
      const values = [...new Set(cands.map((c) => c.token))];
      if (values.length === 1) {
        cands[0]!.consumed = true;
        return { ocr: values[0]! };
      }
      if (values.length > 1) return 'ambiguous';
    }
    return null;
  }
}

const NUM_RE = /\d[\d.,/:%-]*\d|\d/g;
const ZERO_BOX: BBox = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Provenance for the review events emitted while anchoring one field. */
export interface AnchorCtx {
  box: BBox;
  field: NonNullable<ReviewItem['field']>;
  cell?: { row: number; col: number };
}

/**
 * Audit/rewrite numeric tokens in one text field. Returns the new text and, as a
 * side effect, pushes a ReviewItem to `stats.events` for every numeric token the
 * VLM did NOT exactly match against the OCR pool (the cross-model disagreement
 * signal). Exact matches are agreement and emit nothing. Char spans are offsets
 * into the returned text (zero-width for dropped tokens); they are clamped after
 * the cosmetic cleanup, with `ctx.box` as the reliable highlight fallback.
 */
export function anchorText(text: string, region: number, pool: NumberPool, policy: AnchorPolicy, stats: AnchorStats, ctx?: AnchorCtx): string {
  if (policy === 'off') return text;
  const evBase = stats.events.length;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(NUM_RE)) {
    const raw = m[0]!;
    const tok = raw.replace(/[.,/:%-]+$/, '');
    if (!/\d/.test(tok)) continue;
    stats.total++;
    const start = m.index!;
    const end = start + tok.length; // trailing punct stays in the text untouched
    let replacement = tok;
    let drop = false;
    // null = exact agreement → no review event.
    let ev: { kind: ReviewKind; ocr: string | null; severity: 'high' | 'low' } | null = null;

    if (pool.takeExact(tok, region)) {
      stats.exact++;
    } else {
      const sj = pool.takeSplitJoin(tok, region);
      if (sj) {
        stats.splitJoined++;
        // A '-'-joined compression of two separate OCR tokens is a printed spaced
        // range ("12.0 - 15.5") the VLM tightened; replace-policy emits OCR's
        // reading in GT spacing. Decimal/date/ratio separators stay verbatim.
        if (policy === 'replace' && tok === `${sj.a}-${sj.b}`) replacement = `${sj.a} - ${sj.b}`;
        // Attested by OCR but segmented differently — low-severity heads-up.
        ev = { kind: 'split-joined', ocr: `${sj.a} ${sj.b}`, severity: 'low' };
      } else {
        const e1 = pool.takeEdit1(tok, region);
        if (e1 && e1 !== 'ambiguous') {
          if (policy === 'replace') {
            replacement = e1.ocr;
            stats.replaced.push({ vlm: tok, ocr: e1.ocr });
            ev = { kind: 'replaced', ocr: e1.ocr, severity: 'high' };
          } else {
            stats.flagged.push(tok);
            ev = { kind: 'flagged', ocr: e1.ocr, severity: 'high' };
          }
        } else {
          if (e1 === 'ambiguous') stats.ambiguous.push(tok);
          if (policy === 'replace') {
            drop = true;
            stats.dropped.push(tok);
            ev = { kind: e1 === 'ambiguous' ? 'ambiguous' : 'dropped', ocr: null, severity: 'high' };
          } else {
            stats.flagged.push(tok);
            ev = { kind: e1 === 'ambiguous' ? 'ambiguous' : 'flagged', ocr: null, severity: 'high' };
          }
        }
      }
    }

    out += text.slice(last, start);
    const evStart = out.length;
    if (!drop) out += replacement;
    const evEnd = drop ? evStart : out.length; // zero-width caret for dropped tokens
    last = end;

    if (ev) {
      stats.events.push({
        kind: ev.kind,
        regionIndex: region,
        blockIndex: -1, // stamped by anchorBlocks (local) then the assemble call site (page-level)
        box: ctx?.box ?? ZERO_BOX,
        field: ctx?.field,
        cell: ctx?.cell,
        charStart: evStart,
        charEnd: evEnd,
        ocrReading: ev.ocr,
        vlmReading: tok,
        severity: ev.severity,
      });
    }
  }
  out += text.slice(last);
  // Dropping a token can leave doubled spaces / dangling separators.
  const cleaned = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([.,;:)\]])/g, '$1')
    .replace(/\( /g, '(')
    .trim();
  // The cosmetic cleanup can shift offsets near dropped tokens; clamp this call's
  // event spans to the final length (ctx.box is the reliable highlight fallback).
  for (let k = evBase; k < stats.events.length; k++) {
    const e = stats.events[k]!;
    e.charStart = Math.min(e.charStart, cleaned.length);
    e.charEnd = Math.min(e.charEnd, cleaned.length);
  }
  return cleaned;
}

/** Anchor every text field of VLM-derived blocks in place (returns same array).
 *  Stamps each emitted event with its LOCAL block index (position in `blocks`);
 *  the assemble call site converts that to the page-level DocModel.blocks index. */
export function anchorBlocks(blocks: Block[], region: number, pool: NumberPool, policy: AnchorPolicy, stats: AnchorStats): Block[] {
  if (policy === 'off') return blocks;
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]!;
    const evBase = stats.events.length;
    switch (b.kind) {
      case 'heading':
      case 'paragraph':
        b.text = anchorText(b.text, region, pool, policy, stats, { box: b.box, field: 'text' });
        break;
      case 'listItem':
        if (b.lead) b.lead = anchorText(b.lead, region, pool, policy, stats, { box: b.box, field: 'lead' });
        b.text = anchorText(b.text, region, pool, policy, stats, { box: b.box, field: 'text' });
        break;
      case 'kv':
        b.label = anchorText(b.label, region, pool, policy, stats, { box: b.box, field: 'label' });
        b.value = anchorText(b.value, region, pool, policy, stats, { box: b.box, field: 'value' });
        break;
      case 'table':
        b.cells = b.cells.map((row, r) => row.map((c, col) => anchorText(c, region, pool, policy, stats, { box: b.box, field: 'cell', cell: { row: r, col } })));
        break;
      case 'rule':
        break;
    }
    for (let k = evBase; k < stats.events.length; k++) stats.events[k]!.blockIndex = bi;
  }
  return blocks;
}
