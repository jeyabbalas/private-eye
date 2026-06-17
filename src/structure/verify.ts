/**
 * V — runtime verbatim-coverage verifier (NEXT_PIPELINES §V). The eval-time
 * fabrication/omission checks (src/eval/fabrication.ts, src/eval/omission.ts)
 * judge a page against ground truth; V runs the SAME token logic per page at
 * RUNTIME against the OCR the pipeline already produced, turning "the model
 * didn't fabricate on the test set" into "this page contains only tokens the OCR
 * saw — and here are the exceptions". Pure (no I/O); both E and G already hold an
 * OcrResult, so no separate OCR reference pass is needed.
 *
 *  - fabrication: output tokens absent from the OCR pool (edit-1 forgiven — a
 *    one-digit misread is CER, not invention). ~empty for E by construction and
 *    for G under the 'replace' anchor; a non-empty result is a regression
 *    tripwire. Numerics G already surfaced (uncertainty.reviewItems) are not
 *    double-counted.
 *  - omission:    above-confidence OCR tokens absent from the output (the quieter
 *    clinical failure — D dropped a whole patient field grid while reading
 *    fluently). Low-confidence OCR is excluded so we don't chase OCR noise.
 *  - verdict:     numeric issues are the hard gate (pass | fallback); word-level
 *    rates are advisory (review). V only DECIDES — the act of falling back to E's
 *    deterministic output is the app's, where E and G are wired together.
 *
 * Attribution mirrors the uncertainty contract: a fabrication flag carries the
 * output `blockIndex` it appears in; an omission flag carries the OCR `lineIds`
 * where the dropped token was seen — enough for the app's hover-to-highlight UI.
 */
import type { OcrResult } from '../core/types.ts';
import { extractNumbers, extractWords } from '../eval/normalize.ts';
import { tokensMissingFromPool } from '../eval/token-match.ts';
import type { Block, DocModel } from './blocks.ts';
import type { UncertaintyLayer } from './uncertainty.ts';

export type VerifyVerdict = 'pass' | 'review' | 'fallback';

export interface VerifyThresholds {
  /** OCR line-confidence floor for the omission check: an OCR token the engine
   *  itself barely read is not held against the output as a silent drop. */
  minOcrConf: number;
  /** Verdict=fallback when distinct unverified output NUMBERS exceed this. */
  maxFabNumbers: number;
  /** Verdict=fallback when distinct above-confidence omitted NUMBERS exceed this. */
  maxOmittedNumbers: number;
  /** Verdict=review (advisory) when the word fabrication rate exceeds this. */
  reviewWordFabRate: number;
  /** Verdict=review (advisory) when the word omission rate (1 - recall) exceeds this. */
  reviewWordOmitRate: number;
}

/** Numerics are the safety-critical hard gate (default cap 0); word rates are
 *  advisory. `the eval harness` reports the operating point these imply on
 *  the corpus so they can be calibrated before shipping (cf. eval/uncertainty GATE). */
export const VERIFY_DEFAULTS: VerifyThresholds = {
  minOcrConf: 0.5,
  maxFabNumbers: 0,
  maxOmittedNumbers: 0,
  reviewWordFabRate: 0.02,
  reviewWordOmitRate: 0.05,
};

/** One token that failed verification, with provenance for the audit UI. */
export interface FlaggedToken {
  token: string;
  kind: 'number' | 'word';
  /** Output block the token appears in (fabrication); -1 for omission. */
  blockIndex: number;
  /** OCR line ids the token was seen on (omission); [] for fabrication. */
  lineIds: number[];
}

export interface VerificationResult {
  schema: 'verify/1';
  verdict: VerifyVerdict;
  /** Output tokens the OCR never saw (invention). */
  fabrication: { numbers: FlaggedToken[]; words: FlaggedToken[]; numberRate: number; wordRate: number };
  /** Above-confidence OCR tokens the output dropped (silent data loss). */
  omission: { numbers: FlaggedToken[]; words: FlaggedToken[]; numberRecall: number; wordRecall: number };
  /** One-line caveat mirrored into PageRun.note. */
  summary: string;
}

/** All textual content of a block, for token extraction. */
function blockText(b: Block): string {
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
    case 'rule':
      return '';
  }
}

const pushTo = (m: Map<string, number[]>, k: string, v: number): void => {
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

const NO_LINES: Map<string, number[]> = new Map();
const NO_BLOCK: Map<string, number> = new Map();

/** Dedupe raw (duplicate-preserving) missing tokens into flags, attributing each
 *  to its output block (fabrication) or OCR lines (omission). */
function flagsFrom(
  raw: string[],
  kind: 'number' | 'word',
  blockOf: Map<string, number>,
  linesOf: Map<string, number[]>,
): FlaggedToken[] {
  const seen = new Map<string, FlaggedToken>();
  for (const token of raw) {
    if (seen.has(token)) continue;
    seen.set(token, { token, kind, blockIndex: blockOf.get(token) ?? -1, lineIds: linesOf.get(token) ?? [] });
  }
  return [...seen.values()];
}

/**
 * Verify a page's output against the OCR it was built from. `ocr` is whatever
 * reference the pipeline already has (E: PP-OCRv5 full page; G: the exported
 * region+orphan lines) — V adds no OCR pass. `uncertainty` is consulted only to
 * skip numerics Pipeline G's anchor already flagged (uncertainty.reviewItems),
 * so they are surfaced once, not twice.
 */
export function verifyPage(args: {
  doc: DocModel;
  ocr: OcrResult;
  uncertainty?: UncertaintyLayer;
  thresholds?: Partial<VerifyThresholds>;
}): VerificationResult {
  const t = { ...VERIFY_DEFAULTS, ...args.thresholds };

  // Output side: tokens + the block each first appears in.
  const outNums: string[] = [];
  const outWords: string[] = [];
  const numBlock = new Map<string, number>();
  const wordBlock = new Map<string, number>();
  args.doc.blocks.forEach((b, bi) => {
    const text = blockText(b);
    for (const n of extractNumbers(text)) {
      outNums.push(n);
      if (!numBlock.has(n)) numBlock.set(n, bi);
    }
    for (const w of extractWords(text)) {
      outWords.push(w);
      if (!wordBlock.has(w)) wordBlock.set(w, bi);
    }
  });
  const outNumPool = new Set(outNums);
  const outWordPool = new Set(outWords);

  // OCR side: the full pool forgives fabrication (if OCR saw it at all, the model
  // didn't invent it); the above-confidence subset is the omission source.
  const ocrNums: string[] = [];
  const ocrWords: string[] = [];
  const ocrNumAbove: string[] = [];
  const ocrWordAbove: string[] = [];
  const numLine = new Map<string, number[]>();
  const wordLine = new Map<string, number[]>();
  args.ocr.lines.forEach((l, li) => {
    const above = l.conf >= t.minOcrConf;
    for (const n of extractNumbers(l.text)) {
      ocrNums.push(n);
      if (above) {
        ocrNumAbove.push(n);
        pushTo(numLine, n, li);
      }
    }
    for (const w of extractWords(l.text)) {
      ocrWords.push(w);
      if (above) {
        ocrWordAbove.push(w);
        pushTo(wordLine, w, li);
      }
    }
  });
  const ocrNumPool = new Set(ocrNums);
  const ocrWordPool = new Set(ocrWords);

  // Pipeline G's anchor already surfaced these numerics (replaced/flagged/dropped)
  // via reviewItems — don't report them a second time.
  const anchored = new Set(
    (args.uncertainty?.reviewItems ?? []).filter((r) => r.severity === 'high').map((r) => r.vlmReading),
  );

  const rawFabNums = tokensMissingFromPool(outNums, ocrNumPool).filter((n) => !anchored.has(n));
  const rawFabWords = tokensMissingFromPool(outWords, ocrWordPool);
  const rawOmitNums = tokensMissingFromPool(ocrNumAbove, outNumPool);
  const rawOmitWords = tokensMissingFromPool(ocrWordAbove, outWordPool);

  const fabrication = {
    numbers: flagsFrom(rawFabNums, 'number', numBlock, NO_LINES),
    words: flagsFrom(rawFabWords, 'word', wordBlock, NO_LINES),
    numberRate: outNums.length ? rawFabNums.length / outNums.length : 0,
    wordRate: outWords.length ? rawFabWords.length / outWords.length : 0,
  };
  const omission = {
    numbers: flagsFrom(rawOmitNums, 'number', NO_BLOCK, numLine),
    words: flagsFrom(rawOmitWords, 'word', NO_BLOCK, wordLine),
    numberRecall: ocrNumAbove.length ? 1 - rawOmitNums.length / ocrNumAbove.length : 1,
    wordRecall: ocrWordAbove.length ? 1 - rawOmitWords.length / ocrWordAbove.length : 1,
  };

  let verdict: VerifyVerdict = 'pass';
  if (fabrication.numbers.length > t.maxFabNumbers || omission.numbers.length > t.maxOmittedNumbers) {
    verdict = 'fallback';
  } else if (fabrication.wordRate > t.reviewWordFabRate || 1 - omission.wordRecall > t.reviewWordOmitRate) {
    verdict = 'review';
  }

  const parts: string[] = [];
  if (fabrication.numbers.length) parts.push(`${fabrication.numbers.length} unverified number(s)`);
  if (omission.numbers.length) parts.push(`${omission.numbers.length} omitted number(s)`);
  if (fabrication.words.length) parts.push(`${fabrication.words.length} unverified word(s)`);
  if (omission.words.length) parts.push(`${omission.words.length} omitted word(s)`);
  const summary = `verify[${verdict}]${parts.length ? `: ${parts.join(', ')}` : ': all tokens OCR-attested'}`;

  return { schema: 'verify/1', verdict, fabrication, omission, summary };
}
