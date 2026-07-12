/**
 * Content cues: is a cell text label-shaped or value-shaped?
 *
 * These are TYPE DETECTORS (shape regexes over character classes), not word
 * lists — "03 APR 2024" is a date because of its digit/month/digit shape, not
 * because any fixture contains it. Votes are on [-1, 1]: positive = label,
 * negative = value.
 *
 * Hierarchical combination (plan §Design 3): STRONG cues clamp the vote
 * (trailing colon; date/id/number+unit/person-name/sentence shapes) because
 * they are near-decisive alone; everything else contributes to a soft sum that
 * is clamped and NEVER individually decisive. Downstream, votes are combined
 * across a row/column and blended with context, so no single cell cue ever
 * decides a pairing by itself.
 */
import type { Seg } from '../fragments.ts';
import { lexiconKey, type PageLexicon } from './types.ts';

export interface CellVote {
  /** [-1, 1]; positive = label-typed, negative = value-typed. */
  v: number;
  /** A near-decisive shape cue fired (vote should not be diluted by context). */
  strong: boolean;
}

// --- shape detectors (each answers: does the WHOLE text have this shape?) ---

const DATE_SHAPES = [
  /^\d{1,2}[ \-/.](?:[A-Za-z]{3,9}\.?|\d{1,2})[ \-/.,]\s?\d{2,4}$/, // 11 FEB 1968, 12/01/2014, 12 September 1985
  /^[A-Za-z]{3,9}\.?\s\d{1,2},?\s\d{2,4}$/, // October 15, 2023
  /^\d{4}-\d{2}-\d{2}$/, // 2024-03-07
];
export const isDateShaped = (t: string): boolean => DATE_SHAPES.some((re) => re.test(t));

/** Identifier: compact alphanumeric with digit majority once separators are
 *  stripped — accession/hospital/phone numbers ("MR-7781-2240", "434 257 1829"). */
export function isIdShaped(t: string): boolean {
  const compact = t.replace(/[\s\-/.+()]/g, '');
  if (compact.length < 5 || !/^[A-Za-z0-9]+$/.test(compact)) return false;
  const digits = compact.replace(/\D/g, '').length;
  return digits / compact.length >= 0.6;
}

/** "18 mm", "8.4 ng/mL", "40%", "1+"… a measurement is never a label. */
export function isMeasurementShaped(t: string): boolean {
  return (
    /^[<>~≈]?\d+(?:[.,]\d+)?\s*[A-Za-zµ%°]{1,7}(?:\/[A-Za-zµ]{1,7})?$/.test(t) ||
    /^[<>~≈]?\d+(?:[.,:/+=×x-]\d+)*\s*%?$/.test(t)
  );
}

/** Person-name shape: honorific prefix, or a comma-separated sequence of
 *  capitalized words ("ALVAREZ, RAMON"; "ELIZABETH SMITH, MEDICAL WARD, USA").
 *  "Prostate, biopsy" does NOT match — the post-comma word is lowercase. */
export function isNameShaped(t: string): boolean {
  if (/^(?:Dr|Mr|Mrs|Ms|Prof)\.?\s+\S/i.test(t)) return true;
  if (!/^[A-Z][A-Za-z'’ .-]{0,30},\s+[A-Z]/.test(t)) return false;
  const words = t.split(/[\s,]+/).filter(Boolean);
  return words.length <= 6 && words.every((w) => /^[A-Z]/.test(w));
}

/** Running prose: long, with a healthy share of lowercase-starting words. */
export function isSentenceShaped(t: string): boolean {
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const lower = words.filter((w) => /^[a-z]/.test(w)).length;
  return lower / words.length >= 0.4;
}

/** Marker/code token like CD20, HbA1c, HER2, pT1c: letters+small number. The
 *  digit-share cue is SUPPRESSED for these (their digits are nomenclature, not
 *  data), so a marker column can still read as labels. */
const MARKER_TOKEN = /^[A-Za-z]{1,7}-?\d{1,3}[a-z]?$/;

const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));

/** Vote for one cell text. `lexicon` is optional page context (repetition cue). */
export function cellVote(text: string, lexicon?: PageLexicon): CellVote {
  const t = text.trim();
  if (!t) return { v: 0, strong: false };

  // Strong cues clamp. If several fire, they average (a colon-suffixed date is
  // genuinely ambiguous and should not pretend certainty).
  const strong: number[] = [];
  if (/:$/.test(t) && t.length > 1) strong.push(1);
  const body = t.replace(/:$/, '').trim();
  if (isDateShaped(body) || isIdShaped(body) || isMeasurementShaped(body)) strong.push(-1);
  else if (isNameShaped(body) || isSentenceShaped(body)) strong.push(-1);
  if (strong.length) {
    return { v: clamp1(strong.reduce((a, b) => a + b, 0) / strong.length), strong: true };
  }

  // Weak cues: a soft SUM (clamped) — several mild signals may add up, but any
  // one of them alone stays far from decisive.
  const words = body.split(/\s+/).filter(Boolean);
  let v = 0;
  // Field labels are short; long texts lean value.
  v += words.length <= 2 ? 0.4 : words.length <= 4 ? 0.15 : words.length <= 7 ? -0.3 : -0.6;
  // Printed labels are ALL-CAPS or Title Case; lowercase starts lean value.
  if (/^[a-z]/.test(body)) v -= 0.25;
  else if (words.every((w) => /^[A-Z0-9(]/.test(w))) v += 0.3;
  // Digits lean value — except marker nomenclature (CD20); ≥2 marker tokens
  // together (staging codes "pT1c pN0") lean value again.
  const markers = words.filter((w) => MARKER_TOKEN.test(w)).length;
  if (markers === words.length && markers >= 2) v -= 0.3;
  else if (!(markers === words.length && markers === 1)) {
    const alnum = body.replace(/[^A-Za-z0-9]/g, '');
    const digits = body.replace(/\D/g, '');
    if (alnum.length) v -= 0.8 * Math.min(1, (2 * digits.length) / alnum.length);
  }
  // Terminal sentence punctuation leans value — but not dotted abbreviations
  // ("Hospital No.", "Ref.").
  if (/[.,;]$/.test(body)) {
    const lastWord = words[words.length - 1] ?? '';
    const abbrev = /\.$/.test(body) && lastWord.length <= 4;
    if (!abbrev) v -= 0.3;
  }
  // Repetition: this text appears with a trailing colon elsewhere on the page /
  // in a detected grid header — label evidence beyond this one cell.
  if (lexicon?.labels.has(lexiconKey(body))) v += 0.5;

  return { v: clamp1(v), strong: false };
}

/** Confidence-weighted mean vote of a row/column of cells (strong cues weigh
 *  double a weak sum). Empty input → 0 (no evidence). */
export function groupVote(votes: CellVote[]): number {
  let num = 0;
  let den = 0;
  for (const c of votes) {
    const w = c.strong ? 1 : 0.5;
    num += w * c.v;
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/** Blend a cell's own vote with its group context: strong cues stand alone;
 *  weak cells inherit their type mostly from the company they keep — a bare
 *  "Male" is label-SHAPED (short, capitalized), and only its value-typed row
 *  says otherwise, so context gets the majority share. Kills date-as-label
 *  pairs the same way (a strong date never blends). */
export function blendContext(cell: CellVote, context: number): number {
  return cell.strong ? cell.v : (cell.v + 2 * context) / 3;
}

/** Trailing-colon label texts across the page (the cheap lexicon first pass). */
export function collectColonLabels(segs: Seg[], into: PageLexicon): void {
  for (const s of segs) {
    const t = s.text.trim();
    if (/:$/.test(t) && t.length > 1 && t.split(/\s+/).length <= 7) into.labels.add(lexiconKey(t));
  }
}
