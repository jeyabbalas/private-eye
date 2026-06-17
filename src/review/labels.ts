/**
 * Plain-language mapping — the ONE place internal signals become consumer words
 * and colors. Nothing here (or anything it feeds) may surface jargon like
 * "isotonic / logit / softmax / CTC / VLM / OCR" in user-visible text; the
 * Technical-details block in the error modal is the only exception.
 */
import type { VerificationResult, VerifyVerdict } from '../structure/verify.ts';
import type { ReviewKind } from '../structure/uncertainty.ts';

export type Tone = 'ok' | 'caution' | 'attention';

/** Confidence bands (plain language). Below 0.5 = low; 0.5–0.8 = worth a look;
 *  at/above 0.8 = no highlight. */
export type Band = 'ok' | 'caution' | 'low';

export function confidenceBand(conf: number): Band {
  if (conf < 0.5) return 'low';
  if (conf < 0.8) return 'caution';
  return 'ok';
}

export const BAND_LABEL: Record<Band, string> = {
  low: 'low confidence',
  caution: 'worth a look',
  ok: 'looks clear',
};

/** CSS custom-property names (see app.css) for each band's highlight color. */
export const BAND_VAR: Record<Band, string> = {
  low: '--attention',
  caution: '--caution',
  ok: '--ok',
};

/** RGBA fill alphas per band (red ~0.30, amber ~0.18, none). */
export const BAND_ALPHA: Record<Band, number> = {
  low: 0.3,
  caution: 0.18,
  ok: 0,
};

export function pipelineLabel(pipeline: 'E' | 'G'): string {
  return pipeline === 'E' ? 'Exact transcription' : 'AI-assisted (numbers double-checked)';
}

export interface VerdictView {
  tone: Tone;
  title: string;
  detail: string;
}

/** Turn the verifier verdict (and any safety fallback) into a banner sentence. */
export function verdictView(
  v: VerificationResult | undefined,
  fellBack: boolean,
): VerdictView {
  if (fellBack) {
    return {
      tone: 'caution',
      title: 'Switched to the exact transcription here',
      detail:
        'The AI-assisted reading tripped a safety check, so Private Eye kept the exact, copied-from-the-page version instead.',
    };
  }
  const verdict: VerifyVerdict = v?.verdict ?? 'pass';
  switch (verdict) {
    case 'pass':
      return {
        tone: 'ok',
        title: 'Checks passed',
        detail: 'Every number in the result was found in the scan.',
      };
    case 'review':
      return { tone: 'caution', title: 'A few things to skim', detail: countsSentence(v) };
    case 'fallback':
      return { tone: 'attention', title: 'Worth your eyes', detail: countsSentence(v) };
  }
}

/** Plain sentence summarizing the verifier's flagged counts. */
export function countsSentence(v: VerificationResult | undefined): string {
  if (!v) return 'A few spots are worth a quick look.';
  const parts: string[] = [];
  const fn = v.fabrication.numbers.length;
  const on = v.omission.numbers.length;
  const fw = v.fabrication.words.length;
  const ow = v.omission.words.length;
  if (fn) parts.push(`${fn} number${fn > 1 ? 's' : ''} in the result ${fn > 1 ? 'weren’t' : 'wasn’t'} found in the scan`);
  if (on) parts.push(`${on} number${on > 1 ? 's' : ''} from the scan may be missing`);
  if (fw) parts.push(`${fw} word${fw > 1 ? 's' : ''} couldn’t be matched to the scan`);
  if (ow) parts.push(`${ow} word${ow > 1 ? 's' : ''} from the scan may be missing`);
  if (!parts.length) return 'Everything matched the scan.';
  return `${parts.join('; ')}.`;
}

/** Cross-model disagreement kinds (Deep Read) → plain phrasing. */
export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  replaced: 'AI replaced the exact reading',
  flagged: 'readings differ',
  dropped: 'the AI left this out',
  ambiguous: 'hard to read',
  'split-joined': 'grouping differs',
  'disagree-text': 'wording differs',
};

export const COVERAGE_GAP_LABEL = 'possible missed area';
