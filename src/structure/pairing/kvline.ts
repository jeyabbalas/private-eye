/**
 * Validated single-line "Label: value" parsing — the ONE splitter shared by
 * every path that meets a colon line (Pipeline B/E line classification, list
 * run-in leads, Pipeline G's VLM kv assertions).
 *
 * Replaces the old charset regexes, which encoded "labels never contain
 * commas or parentheses and start uppercase" — false on real reports
 * ("Prostate, biopsy: …", "pT2: …") — while still accepting prose lead-ins
 * ("…should include the following: a, b"). Acceptance is now structure plus
 * semantics:
 *
 *  - STRUCTURE (both modes): label of 1–7 words containing a letter; brackets
 *    balanced on BOTH sides of the split (a colon inside an unmatched paren
 *    is quoting prose, not separating a field); no terminal sentence
 *    punctuation on the label (dotted abbreviations like "Hospital No."
 *    exempt); non-empty value; not a clock reading the OCR spaced out
 *    ("Collected 10: 30 AM").
 *  - SEMANTICS (strict mode): the same content cues the grid interpreter
 *    votes with must jointly beat neutrality —
 *    sqrt(σ(v(label))·σ(−v(value))) > linesScore, where linesScore = 0.5 is
 *    the neutral point of the type score (σ(0)·σ(0) = 0.25 under the sqrt),
 *    not a tuned constant. Lenient mode (the VLM's own `**Label:** value`
 *    assertions, whose tokens the numeric anchor layer audits downstream)
 *    checks structure only.
 */
import { cellVote } from './features.ts';
import { typePlausibility } from './score.ts';
import { DEFAULT_WEIGHTS, type PairingWeights } from './weights.ts';

export interface ParsedKvLine {
  isKv: boolean;
  label?: string;
  value?: string;
}

export interface KvLineOptions {
  /** Skip the semantic bar (structure only) — for spans something upstream
   *  already asserted are kv (the VLM's bold-label lines). */
  lenient?: boolean;
  weights?: PairingWeights;
}

/** Balanced (), [] with no close-before-open. */
function bracketsBalanced(t: string): boolean {
  let round = 0;
  let square = 0;
  for (const ch of t) {
    if (ch === '(') round++;
    else if (ch === ')') round--;
    else if (ch === '[') square++;
    else if (ch === ']') square--;
    if (round < 0 || square < 0) return false;
  }
  return round === 0 && square === 0;
}

/** "Collected 10: 30 AM" — a clock reading the OCR spaced out, not a field
 *  split: 1–2 trailing digits meet exactly two leading digits. */
function isClockSplit(label: string, value: string): boolean {
  return /(^|[^\d])\d{1,2}$/.test(label) && /^\d{2}([^\d]|$)/.test(value);
}

/** A field value is one phrase; running prose across an internal sentence
 *  boundary is a paragraph the OCR happened to open with a "Site: finding…"
 *  shape (GT renders those as paragraphs, not fields). The boundary is a
 *  ≥3-letter lowercase word — so NOT an abbreviation like "Dr." or "R." —
 *  ending a sentence before another capitalized word begins. */
function valueIsProse(value: string): boolean {
  return /[a-z]{3,}[.?!]\s+[A-Z]/.test(value);
}

/** Structural validity of one asserted label/value split (mode-independent). */
export function validKvShape(label: string, value: string): boolean {
  if (!label || !value) return false;
  if (!/[A-Za-z]/.test(label)) return false;
  const words = label.split(/\s+/);
  if (words.length > 7) return false;
  if (!bracketsBalanced(label) || !bracketsBalanced(value)) return false;
  if (/[,;]$/.test(label)) return false;
  // A terminal period is sentence punctuation — unless it dots a short
  // abbreviation ("Hospital No.", "Ref."), mirroring the cellVote guard.
  if (/\.$/.test(label) && (words[words.length - 1]?.length ?? 0) > 4) return false;
  return true;
}

/** Semantic acceptance score: how label→value does this split read.
 *
 *  Votes are taken on the colon-stripped sides — the colon exists in every
 *  candidate split by construction, so it must contribute nothing. The two
 *  sides are asymmetric in what discriminates:
 *   - LEFT: full vote. Weak cues ARE the signal — prose lead-ins ("…should
 *     include the following") are long and lowercase-ridden.
 *   - RIGHT: strong cues only. Short capitalized words ("Left", "Male",
 *     "Positive") are exactly as common as field VALUES as they are as
 *     labels, so weak label-shape carries no evidence about the split; a
 *     decisive shape does (date/id/name/measurement/sentence → value;
 *     trailing colon → this is another label, not a value). */
export function kvSemanticScore(label: string, value: string, w: PairingWeights = DEFAULT_WEIGHTS): number {
  const right = cellVote(value);
  return typePlausibility(cellVote(label).v, right.strong ? right.v : 0, w.sigmaK);
}

function acceptSplit(label: string, value: string, opts?: KvLineOptions): boolean {
  if (isClockSplit(label, value)) return false;
  if (!validKvShape(label, value)) return false;
  // Lenient (VLM-asserted) accepts any structurally valid split — the anchor
  // layer audits its tokens. Strict adds semantics: a value-typed value under
  // a label-typed label, and NOT multi-sentence prose.
  if (opts?.lenient) return true;
  const w = opts?.weights ?? DEFAULT_WEIGHTS;
  return !valueIsProse(value) && kvSemanticScore(label, value, w) > w.linesScore;
}

/** First accepted ": " split of a line, left to right. Not-kv when no split
 *  passes (terminal-colon lead-ins have no value and never match). */
export function parseKvLine(text: string, opts?: KvLineOptions): ParsedKvLine {
  const t = text.replace(/\s+/g, ' ').trim();
  for (let i = t.indexOf(': '); i >= 0; i = t.indexOf(': ', i + 1)) {
    const label = t.slice(0, i).trim();
    const value = t.slice(i + 2).trim();
    if (acceptSplit(label, value, opts)) return { isKv: true, label, value };
  }
  return { isKv: false };
}

// NOTE: multi-field lines ("SPECIMEN DATE: 12 Jan 2014 RECEIVED: 13 Jan 2014")
// stay ONE pair with the second field inside the value. Splitting them needs a
// label-onset signal (where does the next label START inside the span between
// two colons?) that the type cues cannot resolve — "Ward: MEDICAL WARD
// Physician: Dr. X" admits both "Physician" and "WARD Physician" as
// suffix-labels. Deferred to Stage 3 fitting rather than an ad-hoc tiebreak.
