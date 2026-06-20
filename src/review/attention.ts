/**
 * The attention model: one ordered worklist that decides what the reviewer should
 * look at, and in what order. Priority tiers (plan §I):
 *   1. cross-model numeric conflicts (Deep Read)        — always shown
 *   2. verifier hard-gate numbers (unverified / omitted) — always shown
 *   3. low-confidence blocks (worst < τ), worst-first
 *   4. low-confidence lines (p10 < τ), worst-first
 *   5. coverage gaps (possible missed areas)             — always shown
 *   6. advisory word-level disagreements
 *
 * The threshold τ filters the GRADED sources (blocks/lines); CATEGORICAL items
 * (conflicts, hard-gate numbers, gaps) are always shown regardless of τ. Within a
 * tier, lower confidence sorts first.
 */
import type { BBox } from '../core/types.ts';
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import type { VerificationResult } from '../structure/verify.ts';
import { confidenceBand, type Band } from './labels.ts';

/** τ range for the highlight-sensitivity slider. Higher τ flags more (anything
 *  below the threshold); lower τ flags only the shakiest. The default sits at the
 *  low/worth-a-look band boundary (0.5): because a block's score is the MIN over
 *  its characters, a higher default would flag nearly every block on a clean
 *  scan. So the default worklist stays focused on genuinely uncertain regions
 *  (and the overlay shows red only); dragging right reveals the amber tier. */
export const TAU_MIN = 0.3;
export const TAU_MAX = 0.95;
export const TAU_DEFAULT = 0.5;

export type AttentionCategory =
  | 'conflict'
  | 'unverified-number'
  | 'omitted-number'
  | 'low-block'
  | 'low-line'
  | 'coverage-gap'
  | 'advisory-word';

export interface AttentionItem {
  /** Stable id (also the dismiss target). */
  id: string;
  category: AttentionCategory;
  /** Tier (lower first). */
  rank: number;
  /** Within-tier sort key; lower = more urgent (ascending confidence). */
  score: number;
  /** Page-pixel region to pan/highlight. */
  box: BBox;
  /** Linked rendered block, when known. */
  blockIndex?: number;
  /** Linked OCR line ids (for hover-highlight). */
  lineIds: number[];
  title: string;
  detail: string;
  /** Always shown (categorical) vs τ-filtered (graded). */
  graded: boolean;
  /** The exact token this item is about, when there is one (a number/word), so the
   *  Markdown pane can highlight that substring inline. Absent for region-level
   *  items (low-confidence blocks/lines, coverage gaps). */
  token?: string;
  /** For cross-model conflicts: the two candidate readings, so the reviewer can
   *  one-click accept the scan reading over the AI one (when the scan has one). */
  conflict?: { ocrReading: string | null; vlmReading: string };
}

export const CATEGORY_LABEL: Record<AttentionCategory, string> = {
  conflict: 'Readings disagree',
  'unverified-number': 'Number not found in scan',
  'omitted-number': 'Possible missing number',
  'low-block': 'Low-confidence area',
  'low-line': 'Low-confidence line',
  'coverage-gap': 'Possible missed area',
  'advisory-word': 'Wording to skim',
};

const RANK: Record<AttentionCategory, number> = {
  conflict: 0,
  'unverified-number': 1,
  'omitted-number': 1,
  'low-block': 2,
  'low-line': 3,
  'coverage-gap': 4,
  'advisory-word': 5,
};

const WHOLE_PAGE = (layer: UncertaintyLayer): BBox => ({ x0: 0, y0: 0, x1: layer.width, y1: layer.height });

function blockBox(layer: UncertaintyLayer, blockIndex: number): BBox | undefined {
  return layer.blocks.find((b) => b.blockIndex === blockIndex)?.box;
}

function lineBox(layer: UncertaintyLayer, lineId: number): BBox | undefined {
  return layer.lines.find((l) => l.lineId === lineId)?.box;
}

function unionBoxes(boxes: BBox[]): BBox | undefined {
  if (!boxes.length) return undefined;
  return boxes.reduce((a, b) => ({
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  }));
}

/**
 * Build the worklist. `tau` is the confidence threshold for graded items.
 * `dismissed` ids are dropped. The result is sorted by (rank, score).
 */
export function buildAttention(
  layer: UncertaintyLayer | undefined,
  verification: VerificationResult | undefined,
  tau: number,
  dismissed: Set<string> = new Set(),
): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (!layer) return items;

  // 1. cross-model numeric conflicts (Deep Read)
  layer.reviewItems.forEach((r, i) => {
    if (r.severity !== 'high') return;
    items.push({
      id: `conflict:${i}`,
      category: 'conflict',
      rank: RANK.conflict,
      score: 0,
      box: r.box,
      blockIndex: r.blockIndex >= 0 ? r.blockIndex : undefined,
      lineIds: [],
      title: CATEGORY_LABEL.conflict,
      detail:
        r.ocrReading != null
          ? `We used the scan’s “${r.ocrReading}” (the AI read “${r.vlmReading}”).`
          : `The AI read “${r.vlmReading}”, but the scan didn’t confirm it.`,
      graded: false,
      token: r.ocrReading ?? r.vlmReading,
      conflict: { ocrReading: r.ocrReading, vlmReading: r.vlmReading },
    });
  });

  // 2. verifier hard-gate numbers
  if (verification) {
    verification.fabrication.numbers.forEach((f, i) => {
      const box = blockBox(layer, f.blockIndex) ?? WHOLE_PAGE(layer);
      items.push({
        id: `fab:${i}`,
        category: 'unverified-number',
        rank: RANK['unverified-number'],
        score: 0,
        box,
        blockIndex: f.blockIndex >= 0 ? f.blockIndex : undefined,
        lineIds: [],
        title: CATEGORY_LABEL['unverified-number'],
        detail: `“${f.token}” appears in the result but wasn’t found in the scan.`,
        graded: false,
        token: f.token,
      });
    });
    verification.omission.numbers.forEach((f, i) => {
      const box = unionBoxes(f.lineIds.map((id) => lineBox(layer, id)).filter(Boolean) as BBox[]) ?? WHOLE_PAGE(layer);
      items.push({
        id: `omit:${i}`,
        category: 'omitted-number',
        rank: RANK['omitted-number'],
        score: 0,
        box,
        lineIds: f.lineIds,
        title: CATEGORY_LABEL['omitted-number'],
        detail: `“${f.token}” is in the scan but may be missing from the result.`,
        graded: false,
        token: f.token,
      });
    });
  }

  // 3. low-confidence blocks (graded by τ)
  layer.blocks.forEach((b) => {
    if (b.worst >= tau) return;
    items.push({
      id: `block:${b.blockIndex}`,
      category: 'low-block',
      rank: RANK['low-block'],
      score: b.worst,
      box: b.box,
      blockIndex: b.blockIndex,
      lineIds: b.lineIds,
      title: CATEGORY_LABEL['low-block'],
      detail: bandDetail(confidenceBand(b.worst)),
      graded: true,
    });
  });

  // 4. low-confidence lines (graded by τ)
  layer.lines.forEach((l) => {
    if (l.p10 >= tau) return;
    items.push({
      id: `line:${l.lineId}`,
      category: 'low-line',
      rank: RANK['low-line'],
      score: l.p10,
      box: l.box,
      lineIds: [l.lineId],
      title: CATEGORY_LABEL['low-line'],
      detail: `“${truncate(l.text)}” — ${bandDetail(confidenceBand(l.p10))}`,
      graded: true,
    });
  });

  // 5. coverage gaps (always shown)
  layer.coverageGaps.forEach((g, i) => {
    items.push({
      id: `gap:${i}`,
      category: 'coverage-gap',
      rank: RANK['coverage-gap'],
      score: 0,
      box: g.box,
      lineIds: g.lineIds,
      title: CATEGORY_LABEL['coverage-gap'],
      detail: 'Text here may sit outside the detected layout — confirm it was captured.',
      graded: false,
    });
  });

  // 6. advisory word-level conflicts (Deep Read, low severity)
  layer.reviewItems.forEach((r, i) => {
    if (r.severity === 'high') return;
    items.push({
      id: `word:${i}`,
      category: 'advisory-word',
      rank: RANK['advisory-word'],
      score: 0.9,
      box: r.box,
      blockIndex: r.blockIndex >= 0 ? r.blockIndex : undefined,
      lineIds: [],
      title: CATEGORY_LABEL['advisory-word'],
      detail: r.ocrReading != null ? `Scan “${r.ocrReading}” vs AI “${r.vlmReading}”.` : `AI read “${r.vlmReading}”.`,
      graded: true,
      token: r.ocrReading ?? r.vlmReading,
      conflict: { ocrReading: r.ocrReading, vlmReading: r.vlmReading },
    });
  });

  return items.filter((it) => !dismissed.has(it.id)).sort((a, b) => a.rank - b.rank || a.score - b.score);
}

/**
 * How many spots the worklist currently flags at threshold `tau`, after dismissals.
 * This is the single source of truth for "needs review": a page needs review iff
 * this is > 0. Used both at OCR time (initial PageRecord.status) and live (to keep
 * the carousel indicator in sync with the reviewer's activity and the τ slider).
 */
export function reviewItemCount(
  layer: UncertaintyLayer | undefined,
  verification: VerificationResult | undefined,
  tau: number,
  dismissed: Set<string> = new Set(),
): number {
  return buildAttention(layer, verification, tau, dismissed).length;
}

/** Count of items currently demanding attention (drives "N areas need attention"). */
export function attentionCount(items: AttentionItem[]): number {
  return items.length;
}

function bandDetail(band: Band): string {
  return band === 'low' ? 'reading is uncertain here' : 'reading is a little uncertain here';
}

function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
