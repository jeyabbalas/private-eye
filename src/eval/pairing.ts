/**
 * Labeled-field (key–value) pairing metric — did the pipeline bind each printed
 * field label to ITS value? Token recall can't see this (a mispaired value still
 * counts as "found"); this module scores the label↔value ASSOCIATION itself.
 *
 * Ground truth = the `**Label:** value` lines of the gt.md fixtures (the GT
 * convention for field grids). Deliberately NOT extracted via mdast/parseDoc:
 * the tight kv lines are soft line breaks inside one markdown paragraph, so
 * parseDoc flattens them into a single block and the per-line structure is
 * lost. A line-anchored regex is the correct extractor here.
 *
 * Every GT pair that is not recovered lands in exactly one miss bucket so the
 * failure mode is visible, not just the rate:
 *   - mispaired: the value was bound under a WRONG label (the pairing-bug counter);
 *   - inTable:  the label+value binding survived as a two-column table row
 *               (structure differs, binding preserved → `bindingRecall`);
 *   - inList:   the binding survived as a `- **lead:** text` list item (same
 *               deal: block kind differs, association preserved → `bindingRecall`);
 *   - unpaired: the value's tokens are present in the pool but bound nowhere;
 *   - ocrMiss:  the value's tokens never made it out of OCR — not a pairing bug.
 *
 * Pure functions only (no fs/engines) so the module is unit-testable and usable
 * from both the Node harness and any browser-driven eval page.
 */
import type { Block } from '../structure/blocks.ts';
import { normalizeField, normalizeFold } from './normalize.ts';
import { withinEdit1 } from './token-match.ts';

export type FieldKind = 'date' | 'id' | 'name' | 'text';

/** One ground-truth (or predicted) label→value binding. */
export interface KvPair {
  label: string;
  value: string;
}

/** fields.json entry (safety-critical values, per page). */
export interface GtField {
  name: string;
  value: string;
  normalize: FieldKind;
  page: number;
}

/** GT `**Label:** value` line. Bold banners (`**Report**` — no `: ` + value),
 *  `- **lead:**` bullets and `| table |` rows do not match the line anchor. */
const GT_KV_LINE = /^\*\*([^*]+?):\*\*\s+(\S.*)$/;

/** Extract the GT kv pairs from a gt.md (or any rendered markdown) in reading order. */
export function extractKvPairs(md: string): KvPair[] {
  const out: KvPair[] = [];
  for (const line of md.split('\n')) {
    const m = GT_KV_LINE.exec(line.trim());
    if (m) out.push({ label: m[1]!.trim(), value: m[2]!.trim() });
  }
  return out;
}

/** kv blocks of a DocModel, in emission order. */
export function kvPairsFromBlocks(blocks: Block[]): KvPair[] {
  const out: KvPair[] = [];
  for (const b of blocks) if (b.kind === 'kv') out.push({ label: b.label, value: b.value });
  return out;
}

/** Rows of every two-column table block — the "binding preserved, structure
 *  differs" bucket. Wider tables can't carry a label→value row binding. */
export function twoColTableRows(blocks: Block[]): KvPair[] {
  const out: KvPair[] = [];
  for (const b of blocks) {
    if (b.kind !== 'table') continue;
    const cols = Math.max(0, ...b.cells.map((r) => r.length));
    if (cols !== 2) continue;
    for (const row of b.cells) {
      const [l, v] = [row[0]?.trim() ?? '', row[1]?.trim() ?? ''];
      if (l && v) out.push({ label: l, value: v });
    }
  }
  return out;
}

/** GT bindings that are NOT scored pairs but are legitimate pair-shaped output:
 *  `- **lead:** text` bullets, 2-column table rows, and plain `Label: value`
 *  paragraph lines (GT sometimes keeps e.g. signature lines unbolded). An
 *  emitted kv matching one of these is a block-KIND divergence, not a pairing
 *  error → precision-neutral. */
export function gtNeutralBindings(md: string): KvPair[] {
  const out: KvPair[] = [];
  const BULLET_LEAD = /^-\s+\*\*([^*]+?):\*\*\s+(\S.*)$/;
  const TABLE_ROW = /^\|([^|]+)\|([^|]+)\|$/;
  const PLAIN_KV = /^([A-Za-z][^:*|]{0,60}?):\s+(\S.*)$/;
  for (const raw of md.split('\n')) {
    const line = raw.trim();
    const b = BULLET_LEAD.exec(line);
    if (b) {
      out.push({ label: b[1]!.trim(), value: b[2]!.trim() });
      continue;
    }
    const t = TABLE_ROW.exec(line);
    if (t && !/^\s*:?-{3,}/.test(t[1]!)) {
      out.push({ label: t[1]!.trim(), value: t[2]!.trim() });
      continue;
    }
    const p = PLAIN_KV.exec(line);
    if (p && p[1]!.trim().split(/\s+/).length <= 7) out.push({ label: p[1]!.trim(), value: p[2]!.trim() });
  }
  return out;
}

/** listItem-lead bindings of a DocModel (`- **lead:** text`), for the inList bucket. */
export function listLeadPairs(blocks: Block[]): KvPair[] {
  const out: KvPair[] = [];
  for (const b of blocks) {
    if (b.kind === 'listItem' && b.lead?.trim() && b.text.trim()) out.push({ label: b.lead, value: b.text });
  }
  return out;
}

/** Whitespace tokens normalized for the field kind, edge punctuation trimmed
 *  (same forgiveness as the OCR-recall harness: misreads already paid for in
 *  CER are not double-counted as pairing bugs). */
export function tokenize(text: string, kind: FieldKind): string[] {
  return text
    .split(/\s+/)
    .map((t) => normalizeField(t, kind).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => t.length > 0);
}

/** Same token count + position-wise exact-or-edit-1. The matcher for BOTH sides
 *  of a pair (labels use kind 'text'). Strict on token count so "ELIZABETH
 *  SMITH" never matches "ELIZABETH SMITH, MEDICAL WARD, USA". Tokens of ≤2
 *  chars must match exactly: edit-1 on a 1-char token matches ANY char, which
 *  would score a swapped "3"/"0" (lymph-node counts) as a true pair. */
function tokensMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return a.every((t, i) => (t.length <= 2 || b[i]!.length <= 2 ? t === b[i]! : withinEdit1(t, new Set([b[i]!]))));
}

const stripLabel = (s: string): string => s.trim().replace(/[:.]\s*$/, '');

export function labelsMatch(gtLabel: string, predLabel: string): boolean {
  return tokensMatch(tokenize(stripLabel(gtLabel), 'text'), tokenize(stripLabel(predLabel), 'text'));
}

export function valuesMatch(gtValue: string, predValue: string, kind: FieldKind): boolean {
  if (normalizeField(gtValue, kind) === normalizeField(predValue, kind)) return true;
  return tokensMatch(tokenize(gtValue, kind), tokenize(predValue, kind));
}

/** The normalize kind for a GT value: the fields.json entry it matches, else 'text'.
 *  (Also how a GT pair is flagged safety-critical for `criticalRecall`.) */
export function inferKind(gtValue: string, fields: GtField[]): { kind: FieldKind; critical: boolean } {
  for (const f of fields) {
    if (normalizeField(f.value, f.normalize) === normalizeField(gtValue, f.normalize)) {
      return { kind: f.normalize, critical: true };
    }
  }
  return { kind: 'text', critical: false };
}

export type MissBucket = 'mispaired' | 'inTable' | 'inList' | 'unpaired' | 'ocrMiss';

export interface PairOutcome {
  gt: KvPair;
  kind: FieldKind;
  critical: boolean;
  outcome: 'paired' | MissBucket;
  /** For 'paired'/'mispaired': the predicted pair involved. */
  pred?: KvPair;
}

export interface PairingCounts {
  gtPairs: number;
  tp: number;
  fp: number;
  emitted: number;
  mispaired: number;
  inTable: number;
  inList: number;
  unpaired: number;
  ocrMiss: number;
  criticalTotal: number;
  criticalFound: number;
}

export interface PairingScore extends PairingCounts {
  precision: number;
  recall: number;
  f1: number;
  /** (tp + inTable + inList) / gtPairs — binding preserved, in kv, table or list form. */
  bindingRecall: number;
  criticalRecall: number;
  outcomes: PairOutcome[];
  /** Emitted kv pairs that matched nothing in GT (not even a neutral binding). */
  falsePairs: KvPair[];
}

export interface ScoreOptions {
  /** Token pool for the unpaired-vs-ocrMiss split. Defaults to the emitted
   *  blocks' full text; pass the raw OCR text when available (the honest pool:
   *  assembly could in principle drop tokens the OCR saw). */
  ocrText?: string;
}

const blockPoolText = (blocks: Block[]): string =>
  blocks
    .map((b) => {
      switch (b.kind) {
        case 'heading':
        case 'paragraph':
          return b.text;
        case 'listItem':
          return `${b.lead ?? ''} ${b.text}`;
        case 'kv':
          return `${b.label} ${b.value}`;
        case 'table':
          return b.cells.flat().join(' ');
        default:
          return '';
      }
    })
    .join('\n');

/**
 * Score one page: GT pairs (from gt.md) vs emitted blocks.
 * Matching is one-to-one greedy in GT reading order (duplicate labels bind to
 * distinct predictions); a TP needs BOTH label and value to match.
 */
export function scorePagePairing(
  gtMd: string,
  blocks: Block[],
  fields: GtField[],
  opts: ScoreOptions = {},
): PairingScore {
  const gtPairs = extractKvPairs(gtMd);
  const neutral = gtNeutralBindings(gtMd);
  const predicted = kvPairsFromBlocks(blocks);
  const tableRows = twoColTableRows(blocks);
  const listLeads = listLeadPairs(blocks);
  const poolText = opts.ocrText ?? blockPoolText(blocks);

  const consumed = new Set<number>();
  const outcomes: PairOutcome[] = [];

  // Pass 1 — true pairs: greedy one-to-one in GT reading order.
  const matchedPred = new Map<number, number>(); // gt index -> pred index
  gtPairs.forEach((gt, gi) => {
    const { kind } = inferKind(gt.value, fields);
    for (let pi = 0; pi < predicted.length; pi++) {
      if (consumed.has(pi)) continue;
      if (labelsMatch(gt.label, predicted[pi]!.label) && valuesMatch(gt.value, predicted[pi]!.value, kind)) {
        consumed.add(pi);
        matchedPred.set(gi, pi);
        break;
      }
    }
  });

  // Pass 2 — bucket every GT pair.
  const pools: Record<FieldKind, Set<string>> = {
    date: new Set(tokenize(poolText, 'date')),
    id: new Set(tokenize(poolText, 'id')),
    name: new Set(tokenize(poolText, 'name')),
    text: new Set(tokenize(poolText, 'text')),
  };
  gtPairs.forEach((gt, gi) => {
    const { kind, critical } = inferKind(gt.value, fields);
    const pi = matchedPred.get(gi);
    if (pi !== undefined) {
      outcomes.push({ gt, kind, critical, outcome: 'paired', pred: predicted[pi]! });
      return;
    }
    // mispaired: the value appears as SOME unconsumed kv's value under a wrong label.
    const wrong = predicted.findIndex(
      (p, idx) => !consumed.has(idx) && valuesMatch(gt.value, p.value, kind) && !labelsMatch(gt.label, p.label),
    );
    if (wrong >= 0) {
      outcomes.push({ gt, kind, critical, outcome: 'mispaired', pred: predicted[wrong]! });
      return;
    }
    if (tableRows.some((r) => labelsMatch(gt.label, r.label) && valuesMatch(gt.value, r.value, kind))) {
      outcomes.push({ gt, kind, critical, outcome: 'inTable' });
      return;
    }
    if (listLeads.some((r) => labelsMatch(gt.label, r.label) && valuesMatch(gt.value, r.value, kind))) {
      outcomes.push({ gt, kind, critical, outcome: 'inList' });
      return;
    }
    const valueTokens = tokenize(gt.value, kind);
    const inPool = valueTokens.length > 0 && valueTokens.every((t) => withinEdit1(t, pools[kind]));
    outcomes.push({ gt, kind, critical, outcome: inPool ? 'unpaired' : 'ocrMiss' });
  });

  // Precision: emitted kv pairs matching no GT pair AND no neutral GT binding
  // (bullet leads / table rows — right binding, different block kind) are FPs.
  const falsePairs: KvPair[] = [];
  predicted.forEach((p, pi) => {
    if (consumed.has(pi)) return;
    const asGt = gtPairs.some((gt) => {
      const { kind } = inferKind(gt.value, fields);
      return labelsMatch(gt.label, p.label) && valuesMatch(gt.value, p.value, kind);
    });
    if (asGt) return; // duplicate re-emission of a matched pair: not a false pairing
    const asNeutral = neutral.some(
      (n) => labelsMatch(n.label, p.label) && valuesMatch(n.value, p.value, 'text'),
    );
    if (!asNeutral) falsePairs.push(p);
  });

  const count = (o: PairOutcome['outcome']) => outcomes.filter((x) => x.outcome === o).length;
  const counts: PairingCounts = {
    gtPairs: gtPairs.length,
    tp: count('paired'),
    fp: falsePairs.length,
    emitted: predicted.length,
    mispaired: count('mispaired'),
    inTable: count('inTable'),
    inList: count('inList'),
    unpaired: count('unpaired'),
    ocrMiss: count('ocrMiss'),
    criticalTotal: outcomes.filter((o) => o.critical).length,
    criticalFound: outcomes.filter((o) => o.critical && o.outcome === 'paired').length,
  };
  return { ...counts, ...rates(counts), outcomes, falsePairs };
}

export interface PairingRates {
  precision: number;
  recall: number;
  f1: number;
  bindingRecall: number;
  criticalRecall: number;
}

/** Rates from raw counts (also how aggregates/LOLO are derived — sum counts, then rate). */
export function rates(c: PairingCounts): PairingRates {
  const precision = c.tp + c.fp > 0 ? c.tp / (c.tp + c.fp) : 1;
  const recall = c.gtPairs > 0 ? c.tp / c.gtPairs : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    precision,
    recall,
    f1,
    bindingRecall: c.gtPairs > 0 ? (c.tp + c.inTable + c.inList) / c.gtPairs : 1,
    criticalRecall: c.criticalTotal > 0 ? c.criticalFound / c.criticalTotal : 1,
  };
}

export function sumCounts(all: PairingCounts[]): PairingCounts {
  const zero: PairingCounts = {
    gtPairs: 0,
    tp: 0,
    fp: 0,
    emitted: 0,
    mispaired: 0,
    inTable: 0,
    inList: 0,
    unpaired: 0,
    ocrMiss: 0,
    criticalTotal: 0,
    criticalFound: 0,
  };
  return all.reduce(
    (a, c) => ({
      gtPairs: a.gtPairs + c.gtPairs,
      tp: a.tp + c.tp,
      fp: a.fp + c.fp,
      emitted: a.emitted + c.emitted,
      mispaired: a.mispaired + c.mispaired,
      inTable: a.inTable + c.inTable,
      inList: a.inList + (c.inList ?? 0),
      unpaired: a.unpaired + c.unpaired,
      ocrMiss: a.ocrMiss + c.ocrMiss,
      criticalTotal: a.criticalTotal + c.criticalTotal,
      criticalFound: a.criticalFound + c.criticalFound,
    }),
    zero,
  );
}

/** Fixture family = document id (`sample1.001` → `sample1`): the unit the
 *  leave-one-family-out report holds out, so a "gain" carried by one document
 *  is mechanically visible. */
export function familyOf(fixture: string): string {
  return fixture.split('.')[0]!;
}

export interface LoloEntry {
  heldOut: string;
  counts: PairingCounts;
  rates: PairingRates;
}

/** Leave-one-family-out aggregates from per-fixture counts (no re-runs needed). */
export function leaveOneFamilyOut(perFixture: Record<string, PairingCounts>): LoloEntry[] {
  const families = [...new Set(Object.keys(perFixture).map(familyOf))].sort();
  return families.map((heldOut) => {
    const counts = sumCounts(
      Object.entries(perFixture)
        .filter(([fixture]) => familyOf(fixture) !== heldOut)
        .map(([, c]) => c),
    );
    return { heldOut, counts, rates: rates(counts) };
  });
}

/** Duplicate-label safety: matching is label-fold-aware but this helper lets
 *  tests assert the extractor keeps duplicates distinct. */
export function labelFold(label: string): string {
  return normalizeFold(stripLabel(label));
}
