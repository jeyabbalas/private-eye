/**
 * Assemble an OcrResult into a DocModel:
 *   segments → rule/region detection → field-grids & tables → XY-cut ordering →
 *   line classification & merging (headings, bullets+continuations, paragraphs).
 * Pure functions only; no engine or runtime imports, so it runs unchanged in the
 * browser and inside a web worker.
 */
import type { BBox, OcrResult } from '../core/types.ts';
import { boxHeight, unionBox } from '../core/types.ts';
import { buildLineSegments, type Seg } from './fragments.ts';
import { clusterRows, rowPitch } from './rows.ts';
import { median, modeRounded } from './util.ts';
import { isRule, parseBullet, parseKv, splitLead, looksLikeHeading, headingDepth, type PageMetrics } from './classify.ts';
import type { ColAnchor } from './fieldgrid.ts';
import { collectColonLabels } from './pairing/features.ts';
import { interpretRegion, kvInterpretationToBlocks } from './pairing/interpret.ts';
import { emptyLexicon, type PageLexicon } from './pairing/types.ts';
import { buildTable, firstCellIsHeaderWord } from './tables.ts';
import { xyCutOrder } from './xycut.ts';
import type { Block, DocModel } from './blocks.ts';

export { clusterRows, rowPitch };

interface Atom {
  box: BBox;
  blocks?: Block[]; // region (grid/table)
  seg?: Seg; // leftover line
}

export interface AssembleOptions {
  /** When false, suppress heading classification (the page-title shortcut and
   *  looksLikeHeading): used by region-scoped callers (Pipeline E) where a
   *  layout model owns heading decisions. Default true = Pipeline B behavior. */
  headings?: boolean;
  /** Page-global metrics for region-scoped calls. A small region's local
   *  medians (line height, body margin, pitch) skew every downstream threshold
   *  away from the page behavior Pipeline B was validated with; passing the
   *  page values makes assembly of a line subset match B's treatment of the
   *  same lines. wordHeight feeds buildLineSegments' row/gutter scale. */
  metrics?: { wordHeight: number; lineHeight: number; bodyLeft: number; pitch: number };
  /** Field-grid column anchor (see fieldgrid.ts ColAnchor). Advisory since the
   *  pairing interpreter enumerates and scores both anchors; kept for caller
   *  compatibility. */
  colAnchor?: ColAnchor;
  /** Page-level label evidence for the pairing interpreter. Region-scoped
   *  callers (Pipeline E/G) pass the page-wide lexicon; when absent it is
   *  collected from this call's own segments. */
  lexicon?: PageLexicon;
}

export function buildDocModel(ocr: OcrResult, opts: AssembleOptions = {}): DocModel {
  const segs = buildLineSegments(ocr, opts.metrics?.wordHeight);
  if (!segs.length) return { blocks: [], width: ocr.width, height: ocr.height };

  const lineHeight = opts.metrics?.lineHeight ?? (median(segs.map((s) => boxHeight(s.box))) || 12);
  // Body left margin = the most common line start (paragraphs/headings dominate;
  // bullets and continuations are a minority offset to the right).
  const bodyLeft = opts.metrics?.bodyLeft ?? modeRounded(segs.map((s) => s.x0), Math.max(8, lineHeight * 0.5));

  const rows = clusterRows(segs, lineHeight);
  const pitch = opts.metrics?.pitch ?? (rowPitch(rows) || lineHeight);
  const m: PageMetrics = { width: ocr.width || Math.max(...segs.map((s) => s.box.x1)), lineHeight, pitch, bodyLeft };
  const lexicon = opts.lexicon ?? emptyLexicon();
  if (!opts.lexicon) collectColonLabels(segs, lexicon);

  // A row belongs to a grid/table region if it has >=2 cells, or a single cell
  // that is offset well to the right of the body margin (a wrapped value line).
  const gridLike = (row: Seg[]): boolean =>
    row.length >= 2 || (row.length === 1 && row[0]!.x0 > bodyLeft + lineHeight * 2);

  // Find regions = a >=2-cell row followed by a run of grid-like rows.
  const atoms: Atom[] = [];
  const consumed = new Set<Seg>();
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.length >= 2) {
      let j = i + 1;
      while (j < rows.length && gridLike(rows[j]!)) j++;
      const regionRows = rows.slice(i, j);
      if (j - i >= 2) {
        const region = makeRegion(regionRows, m, lexicon);
        if (region) {
          atoms.push(region);
          for (const r of regionRows) for (const s of r) consumed.add(s);
          i = j;
          continue;
        }
      }
    }
    i++;
  }
  // Leftover segments become individual atoms.
  for (const s of segs) if (!consumed.has(s)) atoms.push({ box: s.box, seg: s });

  // Order atoms by reading order.
  const order = xyCutOrder(atoms.map((a) => a.box), lineHeight * 1.2);
  const ordered = order.map((idx) => atoms[idx]!);

  // Pre-pass: find runs of bold-lead lines (sentence values, shared indent) that
  // are really bullet lists whose markers the OCR dropped. Marking the first
  // item lets the merger start the list even where bodyLeft collapses onto the
  // list indent (bullet-heavy pages) and the per-item "indented" test fails.
  const leftoverSegs = ordered.filter((a) => a.seg).map((a) => a.seg!);
  const listStarts = detectListRuns(leftoverSegs, m);

  // Expand atoms into blocks, merging consecutive leftover segments.
  const blocks: Block[] = [];
  const merge = new SegMerger(blocks, m, listStarts, opts.headings ?? true);
  for (const atom of ordered) {
    if (atom.blocks) {
      merge.flush();
      blocks.push(...atom.blocks);
    } else if (atom.seg) {
      merge.add(atom.seg);
    }
  }
  merge.flush();

  return { blocks, width: m.width, height: ocr.height };
}

/**
 * Interpret a candidate multi-cell region. The old hasAlignedColumns gate
 * cascade is gone: its protections (≥2 multi-cell rows, column span, narrow
 * first cells) live on as graded penalties inside the interpreter's scores,
 * where a marginal geometry discounts a reading instead of flipping it at an
 * arbitrary threshold. `firstCellIsHeaderWord` stays a hard table route in
 * Stage 1 (see plan §B.6): a generic column-header word is decisive.
 */
function makeRegion(regionRows: Seg[][], m: PageMetrics, lexicon: PageLexicon): Atom | null {
  const segs = regionRows.flat();
  const box = unionBox(segs.map((s) => s.box));
  if (firstCellIsHeaderWord(regionRows)) {
    const cols = Math.max(...regionRows.map((r) => r.length));
    if (cols >= 2) return { box, blocks: [buildTable(regionRows, m.lineHeight)] };
  }
  const interp = interpretRegion(segs, m, { lexicon });
  if (interp.kind === 'kv') return { box, blocks: kvInterpretationToBlocks(interp) };
  if (interp.kind === 'table') return { box, blocks: [buildTable(interp.rows, m.lineHeight)] };
  return null; // plain lines — the SegMerger takes over
}

const segCenterY = (s: Seg): number => (s.box.y0 + s.box.y1) / 2;

/** A "Label: sentence" line whose value is several words long — the shape of a
 *  bullet whose glyph the OCR dropped, as opposed to a short field (date/id). */
function leadWithSentence(seg: Seg): boolean {
  const sl = splitLead(seg.text);
  if (sl.lead === undefined) return false;
  return sl.text.trim().split(/\s+/).filter(Boolean).length >= 4;
}

/** Find runs of >=2 sentence-valued bold-lead lines that share a left edge
 *  (allowing wrapped continuation lines between them): an un-marked bullet list.
 *  Returns the set of lead segments that should each begin a list item. */
function detectListRuns(orderedSegs: Seg[], m: PageMetrics): Set<Seg> {
  const xtol = Math.max(m.lineHeight, m.width * 0.02);
  const starts = new Set<Seg>();
  let i = 0;
  while (i < orderedSegs.length) {
    if (!leadWithSentence(orderedSegs[i]!)) {
      i++;
      continue;
    }
    const left = orderedSegs[i]!.x0;
    const run: Seg[] = [orderedSegs[i]!];
    let lastCenter = segCenterY(orderedSegs[i]!);
    let j = i + 1;
    while (j < orderedSegs.length) {
      const s = orderedSegs[j]!;
      const c = segCenterY(s);
      if (leadWithSentence(s) && Math.abs(s.x0 - left) < xtol) {
        run.push(s);
        lastCenter = c;
        j++;
      } else if (!leadWithSentence(s) && s.x0 >= left - xtol && c - lastCenter < m.pitch * 2.2) {
        lastCenter = c; // wrapped continuation of the current item
        j++;
      } else break;
    }
    if (run.length >= 2) for (const s of run) starts.add(s);
    i = Math.max(j, i + 1);
  }
  return starts;
}

/** Accumulates leftover line segments into paragraphs / lists / headings / kv. */
class SegMerger {
  private para: Seg[] = [];
  private list: { items: { lead?: string; text: string; box: BBox }[]; contentLeft: number; lastCenter: number } | null = null;
  // Plain field assignments (no TS parameter properties) keep this file loadable
  // under Node's strip-only TypeScript mode (scripts/pairing-harness.ts).
  private out: Block[];
  private m: PageMetrics;
  private listStarts: Set<Seg>;
  private headings: boolean;

  constructor(out: Block[], m: PageMetrics, listStarts: Set<Seg> = new Set(), headings: boolean = true) {
    this.out = out;
    this.m = m;
    this.listStarts = listStarts;
    this.headings = headings;
  }

  private firstSeg = true;
  /** The kv block emitted for the IMMEDIATELY preceding seg, if any — a
   *  wrapped value line may still append to it (see the paragraph branch). */
  private lastKv: { block: Extract<Block, { kind: 'kv' }>; lastCenter: number } | null = null;

  add(seg: Seg): void {
    if (isRule(seg, this.m)) {
      this.firstSeg = false;
      this.lastKv = null;
      this.flush();
      this.out.push({ kind: 'rule', box: seg.box });
      return;
    }
    // The first short non-rule line on the page is the document title (handles
    // ALL-CAPS titles like "CENTRAL PATHOLOGY SERVICES" that the heading
    // heuristic deliberately rejects elsewhere).
    if (this.firstSeg) {
      this.firstSeg = false;
      if (this.headings) {
        const words = seg.text.trim().split(/\s+/).length;
        if (words <= 8 && seg.text.trim().length > 1) {
          this.out.push({ kind: 'heading', depth: 1, text: seg.text.trim(), box: seg.box });
          return;
        }
      }
    }
    const indented = seg.x0 > this.m.bodyLeft + this.m.lineHeight * 0.4;
    const bullet = parseBullet(seg, this.m);
    const withoutMarker = bullet.isBullet ? { lead: bullet.lead, text: bullet.text } : splitLead(seg.text);
    // Text column = after the marker for an explicit bullet, else the line start.
    const contentLeft = bullet.isBullet ? (seg.words[1]?.box.x0 ?? seg.x0) : seg.x0;
    // A new list item starts at an explicit marker, at an indented bold-lead line
    // whose marker the OCR dropped, or — once a list is running — at any bold-lead
    // line sharing the list's left edge (handles bullet-heavy pages where bodyLeft
    // collapses onto the list indent, so "indented" alone fails).
    const alignedWithList =
      this.list !== null && Math.abs(seg.x0 - this.list.contentLeft) < this.m.lineHeight;
    const startsItem =
      bullet.isBullet ||
      this.listStarts.has(seg) ||
      (withoutMarker.lead !== undefined && (indented || alignedWithList));
    if (startsItem) {
      this.lastKv = null;
      this.flushPara();
      if (!this.list) {
        this.list = { items: [], contentLeft, lastCenter: segCenterY(seg) };
        this.pullPrecedingKvIntoList(contentLeft);
      }
      this.list.items.push({ lead: withoutMarker.lead, text: withoutMarker.text, box: seg.box });
      this.list.lastCenter = segCenterY(seg);
      return;
    }
    // List continuation: a line one pitch below the current item that shares (or
    // is indented past) the item's text column, with no new lead. Gaps are
    // measured center-to-center against the line pitch so box-height deflation
    // does not spuriously break continuations.
    const alignedCont = this.list && Math.abs(seg.x0 - this.list.contentLeft) < this.m.lineHeight;
    if (this.list && (indented || alignedCont) && segCenterY(seg) - this.list.lastCenter < this.m.pitch * 1.5) {
      const last = this.list.items[this.list.items.length - 1]!;
      last.text = `${last.text} ${seg.text}`.replace(/\s+/g, ' ').trim();
      this.list.lastCenter = segCenterY(seg);
      return;
    }
    this.flushList();

    // Key-value before heading, so "HOSP No: 8433281829" stays a field, not a heading.
    const kv = parseKv(seg);
    if (kv.isKv) {
      this.flushPara();
      const block: Extract<Block, { kind: 'kv' }> = { kind: 'kv', label: kv.label!, value: kv.value!, box: seg.box };
      this.out.push(block);
      this.lastKv = { block, lastCenter: segCenterY(seg) };
      return;
    }
    if (this.headings && looksLikeHeading(seg, this.m)) {
      this.lastKv = null;
      this.flush();
      this.out.push({ kind: 'heading', depth: headingDepth(seg, this.m), text: seg.text.trim(), box: seg.box });
      return;
    }
    // A wrapped VALUE line: exactly the paragraph-continuation geometry (next
    // row, same left margin) applied to a just-emitted kv line — "Skin, punch
    // biopsy: Nodular carcinoma…" wraps onto a second printed line that must
    // extend the value, not open a paragraph of its own.
    if (!this.para.length && this.lastKv) {
      const gap = segCenterY(seg) - this.lastKv.lastCenter;
      const sameMargin = Math.abs(seg.x0 - this.lastKv.block.box.x0) < this.m.lineHeight * 1.5;
      if (gap > 0 && gap <= this.m.pitch * 1.8 && sameMargin) {
        const b = this.lastKv.block;
        b.value = `${b.value} ${seg.text}`.replace(/\s+/g, ' ').trim();
        b.box = unionBox([b.box, seg.box]);
        this.lastKv.lastCenter = segCenterY(seg);
        return;
      }
    }
    this.lastKv = null;
    // Paragraph line: merge with the running paragraph if close, else start new.
    // Center-to-center gap vs pitch keeps this stable under box-height deflation.
    if (this.para.length) {
      const prev = this.para[this.para.length - 1]!;
      const gap = segCenterY(seg) - segCenterY(prev);
      const sameMargin = Math.abs(seg.x0 - prev.x0) < this.m.lineHeight * 1.5;
      if (gap > this.m.pitch * 1.8 || !sameMargin) this.flushPara();
    }
    this.para.push(seg);
  }

  /** If the block just before a new list is a key-value line sharing the list's
   *  left edge, it is really the list's first item whose marker the OCR dropped. */
  private pullPrecedingKvIntoList(contentLeft: number): void {
    const last = this.out[this.out.length - 1];
    if (last?.kind === 'kv' && Math.abs(last.box.x0 - contentLeft) < this.m.lineHeight * 1.2) {
      this.out.pop();
      this.list!.items.push({ lead: last.label, text: last.value, box: last.box });
    }
  }

  private flushPara(): void {
    if (!this.para.length) return;
    const text = this.para.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    this.out.push({ kind: 'paragraph', text, box: unionBox(this.para.map((s) => s.box)) });
    this.para = [];
  }

  private flushList(): void {
    if (!this.list) return;
    for (const it of this.list.items) this.out.push({ kind: 'listItem', lead: it.lead, text: it.text, box: it.box });
    this.list = null;
  }

  flush(): void {
    this.flushPara();
    this.flushList();
  }
}
