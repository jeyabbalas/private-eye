/** Line-level classification predicates used by the assembler. */
import type { Seg } from './fragments.ts';
import { boxWidth } from '../core/types.ts';
import { parseKvLine, type ParsedKvLine } from './pairing/kvline.ts';

const UNAMBIGUOUS_BULLET = /^[•◦·▪‣*+–—]$/;
// Tesseract misreads bullet glyphs inconsistently: single lowercase letters
// (e/o/c/0) or stray punctuation (« ¢ » ° etc). Accept a short non-word token.
const AMBIGUOUS_BULLET = /^(?:[a-z0]|[^\w\s]{1,2})$/i;

export interface PageMetrics {
  width: number;
  lineHeight: number; // median glyph-box height (engine-dependent; may be deflated)
  /** Median line pitch = center-to-center spacing of consecutive text rows.
   *  Unlike lineHeight this is invariant to box-height deflation, so it is the
   *  correct scale for vertical block-grouping gaps (paragraph/continuation). */
  pitch: number;
  bodyLeft: number; // median left margin of body text
}

/** A wide, near-empty horizontal line = printed rule. Tesseract renders it as
 *  a low-confidence "-"/"—" spanning most of the page. */
export function isRule(seg: Seg, m: PageMetrics): boolean {
  const txt = seg.text.replace(/\s/g, '');
  const wide = boxWidth(seg.box) > m.width * 0.5;
  const dashy = txt.length > 0 && /^[-–—_=.]+$/.test(txt);
  return wide && dashy;
}

export interface BulletParse {
  isBullet: boolean;
  lead?: string;
  text: string;
}

/** Detect a bullet line and strip its marker; split an optional bold run-in lead ("Location: ..."). */
export function parseBullet(seg: Seg, m: PageMetrics): BulletParse {
  const words = seg.words.map((w) => w.text);
  const first = words[0] ?? '';
  // A bullet marker is set off from the following text by a gap wider than a
  // normal inter-word space (hanging indent). This is more reliable than an
  // absolute indent test for the glyphs Tesseract confuses with letters (e/o/0).
  const restX0 = seg.words[1]?.box.x0;
  const markerX1 = seg.words[0]?.box.x1 ?? 0;
  const setOff = restX0 !== undefined && restX0 - markerX1 > m.lineHeight * 0.5;
  const marker =
    UNAMBIGUOUS_BULLET.test(first) || (AMBIGUOUS_BULLET.test(first) && setOff && words.length > 1);
  if (!marker) return { isBullet: false, text: seg.text };
  const rest = words.slice(1).join(' ').replace(/\s+/g, ' ').trim();
  return { isBullet: true, ...splitLead(rest) };
}

/** Split "Lead: rest" into a bold lead + remainder (validated line-kv split —
 *  structure + type semantics, see pairing/kvline.ts). */
export function splitLead(text: string): { lead?: string; text: string } {
  const kv = parseKvLine(text);
  if (kv.isKv) return { lead: kv.label!, text: kv.value! };
  return { text };
}

export type KvParse = ParsedKvLine;

/** Detect a standalone "Label: value" line. Delegates to the validated
 *  line-kv splitter: structural shape (1–7 word label, balanced brackets, no
 *  terminal sentence punctuation — commas/parens/lowercase ARE legal, real
 *  labels use them: "Prostate, biopsy:", "pT2:") plus the semantic bar
 *  (label-typed left, value-typed right must beat neutrality). */
export function parseKvText(text: string): KvParse {
  return parseKvLine(text);
}

export function parseKv(seg: Seg): KvParse {
  return parseKvText(seg.text);
}

/**
 * Heading heuristic: short, not a full sentence. A trailing colon (sample1
 * sections) or Title Case with lowercase (sample2 sections, "Specimen 1") marks
 * a heading; bare ALL-CAPS lines are NOT (they are field values like
 * "MEDICAL WARD"/"USA"). The page title is handled separately by the assembler.
 * Depth is cosmetic (unscored by the metrics).
 */
export function looksLikeHeading(seg: Seg, m: PageMetrics): boolean {
  const t = seg.text.trim();
  if (!t) return false;
  const words = t.split(/\s+/);
  if (words.length > 8) return false;
  if (boxWidth(seg.box) > m.width * 0.62) return false;
  if (/[.,;]$/.test(t)) return false; // sentence-ish
  // A trailing colon marks a section header ("Macroscopic Description:") — but
  // only when short. A long colon line is a lead-in sentence introducing a list
  // ("Histopathological analysis should include the following:"), not a heading.
  if (t.endsWith(':')) return words.length <= 5;
  if (/^specimen\s+\d+/i.test(t) || /^follow[- ]?up/i.test(t)) return true;
  const titleCase = /^[A-Z0-9(]/.test(t) && /[a-z]/.test(t);
  return titleCase;
}

export function headingDepth(seg: Seg, m: PageMetrics): 1 | 2 | 3 {
  const t = seg.text.trim();
  if (/^specimen\s+\d+/i.test(t) || /^follow[- ]?up/i.test(t)) return 3;
  // Centered near the very top → page title.
  const center = (seg.box.x0 + seg.box.x1) / 2;
  if (seg.box.y0 < m.lineHeight * 8 && Math.abs(center - m.width / 2) < m.width * 0.12) return 1;
  return 2;
}
