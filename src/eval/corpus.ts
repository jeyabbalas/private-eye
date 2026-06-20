/**
 * Calibration corpus: the internal normal form for ground-truth text + the pure
 * OCR↔GT character-labeling logic. Dataset *loading* (filesystem) lives in
 * scripts/corpus-load.ts so this module stays browser-portable and unit-testable.
 *
 * Public *medical* OCR ground truth doesn't exist (PHI), so the harness fits and
 * validates on general document OCR (FUNSD scanned forms, SROIE receipts) and
 * treats medical as the transfer target — a calibration map captures the model's
 * softmax↔correctness self-knowledge, which transfers across domains far better
 * than accuracy does.
 */
import type { BBox, OcrLine } from '../core/types.ts';
import { interArea, boxArea, quadToBox } from '../core/types.ts';
import { alignChars, type CharLabel } from './uncertainty.ts';

/** A ground-truth text region (word or line) in page pixel coordinates. */
export interface CorpusLine {
  box: BBox;
  text: string;
}

export type CorpusSplit = 'fit' | 'held-out' | 'transfer';

export interface CorpusPage {
  id: string;
  domain: string; // 'funsd' | 'sroie' | 'medical' — drives the per-domain report
  split: CorpusSplit;
  imagePath: string;
  /** Box-level GT (FUNSD/SROIE): enables per-line spatial alignment. */
  gtLines?: CorpusLine[];
  /** Plain-text GT (medical markdown fixtures): page-level alignment fallback. */
  gtText?: string;
}

const ocrBox = (l: OcrLine): BBox => (l.quad ? quadToBox(l.quad) : l.box);

// A GT item belongs to an OCR line's row when their boxes overlap by ≥30% of the
// SMALLER box's area — robust to word-vs-line size mismatch (a FUNSD word box is
// mostly contained in the OCR line box, so the fraction is high relative to the word).
const ROW_OVERLAP_FRAC = 0.3;

function gtTextForLine(line: OcrLine, gtLines: CorpusLine[]): string | null {
  const ob = ocrBox(line);
  const matched: { x0: number; text: string }[] = [];
  for (const g of gtLines) {
    const denom = Math.min(boxArea(ob), boxArea(g.box)) || 1e-6;
    if (interArea(ob, g.box) / denom >= ROW_OVERLAP_FRAC) matched.push({ x0: g.box.x0, text: g.text });
  }
  if (!matched.length) return null; // no GT here → un-annotated; skip (don't fabricate errors)
  matched.sort((a, b) => a.x0 - b.x0);
  return matched.map((m) => m.text).join(' ');
}

/**
 * Label every recognized character correct/wrong for one page.
 *  - Box-level GT (FUNSD/SROIE): each OCR line is matched to the GT items in its
 *    row and aligned char-by-char. OCR lines with NO overlapping GT are skipped,
 *    not marked wrong — these benchmarks don't annotate every glyph, so counting
 *    an un-annotated real line as error would poison the calibration with
 *    high-confidence false "errors". (Confident false detections are the coverage-
 *    gap signal's job, not the char-confidence signal's.)
 *  - Plain-text GT (medical): the page's OCR text + per-char confidences are
 *    concatenated in reading order and aligned against the GT plain text.
 * Only lines carrying a 1:1 charConf array contribute (alignChars refuses otherwise).
 */
export function labelPage(ocrLines: OcrLine[], page: CorpusPage): CharLabel[] {
  if (page.gtLines) {
    const out: CharLabel[] = [];
    for (const line of ocrLines) {
      if (!line.charConf || line.charConf.length !== [...line.text].length) continue;
      const gt = gtTextForLine(line, page.gtLines);
      if (gt === null) continue;
      out.push(...alignChars(line.text, line.charConf, gt));
    }
    return out;
  }
  if (page.gtText != null) {
    let text = '';
    const conf: number[] = [];
    for (const line of ocrLines) {
      if (!line.charConf || line.charConf.length !== [...line.text].length) continue;
      if (text) {
        text += '\n';
        conf.push(1); // separator: never counted (filtered as whitespace downstream)
      }
      text += line.text;
      conf.push(...line.charConf);
    }
    return alignChars(text, conf, page.gtText);
  }
  return [];
}
