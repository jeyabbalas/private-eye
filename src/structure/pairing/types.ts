/** Types for the unified field-pairing interpreter (structure/pairing/). */
import type { BBox } from '../../core/types.ts';
import type { Seg } from '../fragments.ts';

/** One label↔value association claim over verbatim OCR segments. `conf` scores
 *  the ASSOCIATION (not the characters): the geometric mean of how label/value-
 *  typed the two sides are, how separated the winning assignment was from its
 *  runner-up (Lowe-style margins), and how decisively this interpretation beat
 *  the alternatives. It never alters the emitted text. */
export interface PairedKv {
  label: string;
  value: string;
  box: BBox;
  conf: number;
  labelSegs: Seg[];
  valueSegs: Seg[];
  /** Reading-order keys (label row center / label left edge). */
  y: number;
  x: number;
}

/**
 * The interpreter's verdict for one region. `lines` is the honest null: the
 * region reads as plain lines, and because it scores a fixed neutral value,
 * paragraph soup can never masquerade as a successful grid — a structural
 * reading must BEAT it, not merely exist.
 */
export type RegionInterpretation =
  | { kind: 'kv'; layout: 'stacked' | 'inline'; pairs: PairedKv[]; leftovers: Seg[]; score: number; runnerUp: number }
  | { kind: 'table'; rows: Seg[][]; score: number; runnerUp: number }
  | { kind: 'lines'; score: number; runnerUp: number };

/** Page-level label evidence: texts seen with a trailing colon anywhere on the
 *  page, plus first-row cells of layout-detected grids. An OPTIONAL weak cue
 *  (repetition of a label across contexts) — everything must work with an
 *  empty lexicon. Keys are case-folded, colon-stripped. */
export interface PageLexicon {
  labels: Set<string>;
}

export const emptyLexicon = (): PageLexicon => ({ labels: new Set() });

export const lexiconKey = (text: string): string =>
  text
    .trim()
    .replace(/:$/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
