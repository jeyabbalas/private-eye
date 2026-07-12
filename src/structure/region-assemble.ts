/**
 * Pipeline E's thin assembly: layout regions + full-page OCR lines -> DocModel.
 *
 * The layout model owns the decisions that were Pipeline B's generalization
 * liability (region discovery, heading/title-ness, table localization, reading
 * order). What remains here is the sanctioned residual glue (NEXT_PIPELINES §E):
 * line->region assignment, within-region assembly via buildDocModel with
 * heading classification disabled, and the field-grid emitter — now scoped
 * inside layout-typed regions instead of guessing globally.
 *
 * Safety invariants (omission metric is a hard requirement):
 *  - every OCR line is consumed exactly once (assigned to one region, or
 *    clustered into a synthetic text region when layout missed it);
 *  - inside a table, every line lands in some cell (nearest-cell fallback,
 *    mirroring PP-Structure's TableMatch which never drops a det box).
 */
import type { BBox, OcrLine, OcrResult } from '../core/types.ts';
import { boxArea, boxCenterX, boxCenterY, boxIoU, boxWidth, hOverlapRatio, interArea, unionBox, vOverlapRatio } from '../core/types.ts';
import { buildDocModel, clusterRows, rowPitch, type AssembleOptions } from './assemble.ts';
import { buildLineSegments, wordLineHeight } from './fragments.ts';
import { isRule, parseBullet, parseKv, type PageMetrics } from './classify.ts';
import { collectColonLabels } from './pairing/features.ts';
import { interpretRegion, kvInterpretationToBlocks } from './pairing/interpret.ts';
import { emptyLexicon, lexiconKey, type PageLexicon } from './pairing/types.ts';
import { buildTable, firstCellIsHeaderWord } from './tables.ts';
import { clusterByGap, median, modeRounded } from './util.ts';
import type { Block, DocModel } from './blocks.ts';
import type { UncertaintyLayer } from './uncertainty.ts';
import { blockProvenanceByBox, buildLineUncertainties, orphanCoverageGaps } from './uncertainty-build.ts';
import type { CalibrateFn } from '../core/stats.ts';

export type PageScales = NonNullable<AssembleOptions['metrics']>;

/** Page-global typography scales, computed exactly the way buildDocModel does
 *  for Pipeline B, so region-scoped assembly of a line subset sees the same
 *  thresholds as B's page-wide pass. */
export function pageScales(ocr: OcrResult): PageScales {
  const wordHeight = wordLineHeight(ocr);
  const segs = buildLineSegments(ocr);
  const lineHeight = median(segs.map((s) => s.box.y1 - s.box.y0)) || 12;
  const bodyLeft = modeRounded(segs.map((s) => s.x0), Math.max(8, lineHeight * 0.5));
  const pitch = rowPitch(clusterRows(segs, lineHeight)) || lineHeight;
  return { wordHeight, lineHeight, bodyLeft, pitch };
}

/** Structural subset of engines/layout LayoutRegion (keeps structure/ engine-agnostic). */
export interface Region {
  label: string;
  score: number;
  box: BBox;
  /** Learned reading-order rank; synthetic (orphan) regions get -1. */
  orderRank: number;
}

/** Structural subset of engines/slanet TableStructure, with cell boxes already
 *  mapped to PAGE coordinates by the caller. */
export interface TableCells {
  cells: { box: BBox; row: number; col: number; rowSpan: number; colSpan: number; inThead: boolean }[];
  nRows: number;
  nCols: number;
  theadRows: number;
}

export interface RegionAssembleOptions {
  /** 'learned' = layout model's order head (default); 'geometric' = column-aware band order. */
  order: 'learned' | 'geometric';
}

type RegionKind = 'title' | 'heading' | 'table' | 'imageish' | 'text';

const KIND: Record<string, RegionKind> = {
  doc_title: 'title',
  paragraph_title: 'heading',
  table: 'table',
  image: 'imageish',
  seal: 'imageish',
  chart: 'imageish',
  header_image: 'imageish',
  footer_image: 'imageish',
};
/** Everything not listed (text, content, abstract, aside_text, reference*,
 *  footnote, vision_footnote, header, footer, number, formula*, figure_title,
 *  algorithm, vertical_text) flows through text assembly: GT keeps header/
 *  footer/number text in position, and transcription is always omission-safe. */
const kindOf = (label: string): RegionKind => KIND[label] ?? 'text';

const ASSIGN_MIN_FRAC = 0.5;

/** Per-line region index (-1 = orphan). Score = fraction of the LINE's area
 *  inside the region; ties prefer the smaller region (nested heading over
 *  page-spanning container). Center containment is the fallback acceptance. */
export function assignLinesToRegions(lines: OcrLine[], regions: { box: BBox }[]): number[] {
  return lines.map((line) => {
    const la = boxArea(line.box) || 1e-6;
    const cx = boxCenterX(line.box);
    const cy = boxCenterY(line.box);
    let best = -1;
    let bestFrac = 0;
    let bestArea = Infinity;
    for (let i = 0; i < regions.length; i++) {
      const r = regions[i]!;
      const frac = interArea(line.box, r.box) / la;
      const centerIn = cx >= r.box.x0 && cx <= r.box.x1 && cy >= r.box.y0 && cy <= r.box.y1;
      if (frac < ASSIGN_MIN_FRAC && !centerIn) continue;
      const a = boxArea(r.box);
      if (frac > bestFrac + 1e-9 || (Math.abs(frac - bestFrac) <= 1e-9 && a < bestArea)) {
        best = i;
        bestFrac = frac;
        bestArea = a;
      }
    }
    return best;
  });
}

/** Cluster orphan lines (layout misses) into synthetic text regions by
 *  vertical gap, so they are emitted in position rather than dropped. */
export function synthesizeOrphanRegions(orphans: OcrLine[], lineHeight: number): { region: Region; lines: OcrLine[] }[] {
  if (!orphans.length) return [];
  const sorted = [...orphans].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  const clusters: OcrLine[][] = [[sorted[0]!]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = clusters[clusters.length - 1]!;
    const prevBottom = Math.max(...prev.map((l) => l.box.y1));
    if (sorted[i]!.box.y0 - prevBottom > lineHeight * 2.5) clusters.push([sorted[i]!]);
    else prev.push(sorted[i]!);
  }
  return clusters.map((lines) => ({
    region: { label: 'text', score: 0, box: unionBox(lines.map((l) => l.box)), orderRank: -1 },
    lines,
  }));
}

/**
 * Column-aware geometric reading order (the 'geometric' ablation; also splices
 * synthetic regions). Implements the documented two-column convention (entire
 * left column, then the right): full-width regions (>70% page) act as
 * horizontal band separators emitted in place; within a band, regions cluster
 * into columns by left edge, columns emit left->right, each top->bottom.
 * Collapses to top->bottom on single-column pages.
 */
export function columnAwareOrder(boxes: BBox[], pageW: number): number[] {
  const idx = boxes.map((_, i) => i).sort((a, b) => boxes[a]!.y0 - boxes[b]!.y0 || boxes[a]!.x0 - boxes[b]!.x0);
  const isSeparator = (b: BBox) => boxWidth(b) > 0.7 * pageW;
  const out: number[] = [];
  let band: number[] = [];
  const flush = () => {
    if (!band.length) return;
    const lefts = band.map((i) => boxes[i]!.x0);
    const colCenters = clusterByGap(lefts, 0.12 * pageW);
    const cols: number[][] = colCenters.map(() => []);
    for (const i of band) {
      let c = 0;
      let d = Infinity;
      colCenters.forEach((center, ci) => {
        const dd = Math.abs(boxes[i]!.x0 - center);
        if (dd < d) {
          d = dd;
          c = ci;
        }
      });
      cols[c]!.push(i);
    }
    for (const col of cols) for (const i of col.sort((a, b) => boxes[a]!.y0 - boxes[b]!.y0)) out.push(i);
    band = [];
  };
  for (const i of idx) {
    if (isSeparator(boxes[i]!)) {
      flush();
      out.push(i);
    } else {
      band.push(i);
    }
  }
  flush();
  return out;
}

const regionOcr = (lines: OcrLine[], ocr: OcrResult): OcrResult => ({
  lines,
  width: ocr.width,
  height: ocr.height,
  engineId: ocr.engineId,
});

/** Region text in row order (for title/heading regions). */
function joinedText(lines: OcrLine[]): string {
  return [...lines]
    .sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
    .map((l) => l.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Classify one isolated line: rule, explicit bullet, kv, else paragraph. */
function singleLineBlocks(lines: OcrLine[], ocr: OcrResult, scales: PageScales): Block[] {
  const segs = buildLineSegments(regionOcr(lines, ocr), scales.wordHeight);
  if (!segs.length) return [];
  const m: PageMetrics = { width: ocr.width, lineHeight: scales.lineHeight, pitch: scales.pitch, bodyLeft: scales.bodyLeft };
  const box = unionBox(segs.map((s) => s.box));
  const text = segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  if (segs.length === 1) {
    const seg = segs[0]!;
    if (isRule(seg, m)) return [{ kind: 'rule', box }];
    const bullet = parseBullet(seg, m);
    if (bullet.isBullet) return [{ kind: 'listItem', lead: bullet.lead, text: bullet.text, box }];
  }
  const kv = parseKv({ ...segs[0]!, text, box });
  if (kv.isKv) return [{ kind: 'kv', label: kv.label!, value: kv.value!, box }];
  return [{ kind: 'paragraph', text, box }];
}

/** PP-Structure TableMatch.distance: corner L1 sum + min(top-left, bottom-right). */
function matchDistance(a: BBox, b: BBox): number {
  const dTl = Math.abs(b.x0 - a.x0) + Math.abs(b.y0 - a.y0);
  const dBr = Math.abs(b.x1 - a.x1) + Math.abs(b.y1 - a.y1);
  return dTl + dBr + Math.min(dTl, dBr);
}

/**
 * Fill a SLANet cell grid with OCR text (TableMatch semantics: every line goes
 * to its best cell by (1-IoU, then distance) — nothing is dropped), then
 * flatten to a rectangular GFM grid per GROUND_TRUTH_CONVENTIONS:
 *  - a multi-row <thead> collapses to ONE header row whose leaf cells space-join
 *    the distinct header texts down each column ("Staining" + "Intensity" ->
 *    "Staining Intensity");
 *  - body spans put text in the top-left cell, '' elsewhere (the table metric's
 *    ±1 offset search tolerates this best).
 */
export function fillTableCells(structure: TableCells, lines: OcrLine[]): string[][] {
  const { cells, nRows, nCols, theadRows } = structure;
  if (!nRows || !nCols || !cells.length) return [];
  const texts = new Map<number, string[]>(); // cell index -> texts in line order
  const ordered = [...lines].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
  for (const line of ordered) {
    let best = -1;
    let bestKey: [number, number] = [Infinity, Infinity];
    for (let i = 0; i < cells.length; i++) {
      const key: [number, number] = [1 - boxIoU(line.box, cells[i]!.box), matchDistance(line.box, cells[i]!.box)];
      if (key[0] < bestKey[0] - 1e-12 || (Math.abs(key[0] - bestKey[0]) <= 1e-12 && key[1] < bestKey[1])) {
        bestKey = key;
        best = i;
      }
    }
    if (best >= 0) {
      const arr = texts.get(best) ?? [];
      arr.push(line.text.trim());
      texts.set(best, arr);
    }
  }
  const textOf = (i: number): string => (texts.get(i) ?? []).join(' ').replace(/\s+/g, ' ').trim();

  // Coverage map: which cell owns each (row, col) slot.
  const cellAt: number[][] = Array.from({ length: nRows }, () => Array<number>(nCols).fill(-1));
  cells.forEach((c, i) => {
    for (let r = c.row; r < Math.min(c.row + c.rowSpan, nRows); r++) {
      for (let k = c.col; k < Math.min(c.col + c.colSpan, nCols); k++) cellAt[r]![k] = i;
    }
  });

  const grid: string[][] = [];
  if (theadRows >= 2) {
    const header: string[] = [];
    for (let c = 0; c < nCols; c++) {
      const parts: string[] = [];
      const seen = new Set<number>();
      for (let r = 0; r < theadRows; r++) {
        const i = cellAt[r]![c]!;
        if (i < 0 || seen.has(i)) continue;
        seen.add(i);
        const t = textOf(i);
        if (t) parts.push(t);
      }
      header.push(parts.join(' '));
    }
    grid.push(header);
  }
  const bodyStart = theadRows >= 2 ? theadRows : 0;
  for (let r = bodyStart; r < nRows; r++) {
    const row: string[] = [];
    for (let c = 0; c < nCols; c++) {
      const i = cellAt[r]![c]!;
      const isTopLeft = i >= 0 && cells[i]!.row === r && cells[i]!.col === c;
      row.push(isTopLeft ? textOf(i) : '');
    }
    grid.push(row);
  }
  return grid;
}

/** A degenerate SLANet result falls back to the heuristic table builder. */
const usableStructure = (s: TableCells | null): s is TableCells =>
  !!s && s.cells.length >= 2 && s.nRows >= 1 && s.nCols >= 2;

/**
 * Assemble one layout-`table` region. The layout model is known (P4) to detect
 * the patient field grid as a `table`; B's grid-vs-table discriminator
 * (detectFieldGrid + firstCellIsHeaderWord) routes those back to kv blocks,
 * exactly as in B's makeRegion. Genuine tables go to SLANet (a spanning header
 * is part of the table, recovered via colspan — never peeled off as a heading,
 * which has no support in the seen fixtures where headings are their own
 * paragraph_title regions).
 */
export async function assembleTableRegion(
  lines: OcrLine[],
  ocr: OcrResult,
  region: Region,
  scales: PageScales,
  runSlanet: ((region: Region, lines: OcrLine[]) => Promise<TableCells | null>) | undefined,
  lexicon?: PageLexicon,
): Promise<Block[]> {
  const segs = buildLineSegments(regionOcr(lines, ocr), scales.wordHeight);
  if (!segs.length) return [];
  const m: PageMetrics = { width: ocr.width, lineHeight: scales.lineHeight, pitch: scales.pitch, bodyLeft: scales.bodyLeft };
  const rows = clusterRows(segs, m.lineHeight);

  // A standalone first line above >=2 label/value rows is a section heading the
  // layout model swallowed into the grid box (e.g. "Summary Diagnosis" atop a
  // diagnosis grid). Peel it ONLY on the field-grid branch below — a true data
  // table keeps its leading row (a spanning header is part of the table, not a
  // heading, and SLANet recovers it via colspan).
  const head = rows.length >= 3 && rows[0]!.length === 1 ? rows[0]![0]! : undefined;
  const headIsHeading = !!head && head.text.trim().split(/\s+/).length <= 8 && !/[.,;:]$/.test(head.text.trim());
  const bodyRows = headIsHeading ? rows.slice(1) : rows;

  // Grid-vs-table discrimination, mirroring B's makeRegion precedence: the
  // unified interpreter scores kv/table/lines readings (with the layout
  // model's table prior); a generic header word is still a hard table route.
  const interp = interpretRegion(bodyRows.flat(), m, { tablePrior: true, lexicon });
  if (interp.kind === 'kv' && !firstCellIsHeaderWord(bodyRows)) {
    const heading: Block[] = headIsHeading ? [{ kind: 'heading', depth: 2, text: head!.text.trim(), box: head!.box }] : [];
    return [...heading, ...kvInterpretationToBlocks(interp)];
  }

  // 'table' — and 'lines' too: the layout model called this region a table, so
  // a lines verdict goes to SLANet rather than degrading to paragraph soup.
  const structure = runSlanet ? await runSlanet(region, lines) : null;
  if (usableStructure(structure)) {
    const cells = fillTableCells(structure, lines);
    if (cells.some((r) => r.some((c) => c.trim()))) return [{ kind: 'table', cells, box: region.box }];
  }
  // Heuristic fallback (B's path) — never fail the region.
  return [buildTable(rows, m.lineHeight)];
}

/**
 * Build the document model from layout regions + full-page OCR.
 * `runSlanet` is invoked only for regions confirmed as true tables; it must
 * return cell boxes in PAGE coordinates (or null to use the heuristic builder).
 */
export async function buildDocModelFromRegions(
  ocr: OcrResult,
  regions: Region[],
  opts: RegionAssembleOptions,
  runSlanet?: (region: Region, lines: OcrLine[]) => Promise<TableCells | null>,
): Promise<DocModel> {
  const assignment = assignLinesToRegions(ocr.lines, regions);
  const buckets: OcrLine[][] = regions.map(() => []);
  const orphans: OcrLine[] = [];
  ocr.lines.forEach((line, i) => {
    const r = assignment[i]!;
    if (r >= 0) buckets[r]!.push(line);
    else orphans.push(line);
  });

  const scales = pageScales(ocr);
  const lineHeight = scales.lineHeight;
  const all: { region: Region; lines: OcrLine[] }[] = regions.map((region, i) => ({ region, lines: buckets[i]! }));
  const synthStart = all.length;
  for (const synth of synthesizeOrphanRegions(orphans, lineHeight)) all.push(synth);

  // Page lexicon (weak repetition cue for the pairing interpreter): texts seen
  // with a trailing colon anywhere on the page, plus first-row cells of the
  // layout model's table regions (grid headers repeat as labels). Repetition
  // means evidence from ELSEWHERE: a table region's own first row must not
  // vouch for itself (it would circularly inflate its own header/table score),
  // so each table region gets a lexicon built from the OTHER regions only.
  const baseLexicon = emptyLexicon();
  collectColonLabels(buildLineSegments(ocr, scales.wordHeight), baseLexicon);
  const firstRowKeys = new Map<Region, Set<string>>();
  for (const entry of all) {
    if (kindOf(entry.region.label) !== 'table' || !entry.lines.length) continue;
    const segs = buildLineSegments(regionOcr(entry.lines, ocr), scales.wordHeight);
    const keys = new Set<string>();
    for (const cell of clusterRows(segs, scales.lineHeight)[0] ?? []) {
      const t = cell.text.trim();
      if (t && t.split(/\s+/).length <= 4) keys.add(lexiconKey(t));
    }
    if (keys.size) firstRowKeys.set(entry.region, keys);
  }
  const lexiconExcluding = (self?: Region): PageLexicon => {
    const lex: PageLexicon = { labels: new Set(baseLexicon.labels) };
    for (const [region, keys] of firstRowKeys) {
      if (region === self) continue;
      for (const k of keys) lex.labels.add(k);
    }
    return lex;
  };
  const lexicon = lexiconExcluding();

  // Reading order over the combined set.
  let order: number[];
  if (opts.order === 'geometric') {
    order = columnAwareOrder(all.map((e) => e.region.box), ocr.width);
  } else {
    // Learned order for real regions (engine output is rank-sorted). Each
    // synthetic region splices in row-major: before the first real region that
    // is either clearly below the synthetic's first line, or in the same
    // visual row band but to its right.
    order = all.slice(0, synthStart).map((_, i) => i);
    for (let s = synthStart; s < all.length; s++) {
      const first = [...all[s]!.lines].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)[0];
      const fBox = first?.box ?? all[s]!.region.box;
      const fCy = (fBox.y0 + fBox.y1) / 2;
      let pos = order.findIndex((i) => {
        if (i >= synthStart) return false;
        const rb = all[i]!.region.box;
        if (vOverlapRatio(fBox, rb) > 0.3) return rb.x0 > fBox.x0; // same band: emit lefts first
        return (rb.y0 + rb.y1) / 2 > fCy;
      });
      if (pos < 0) pos = order.length;
      order.splice(pos, 0, s);
    }
  }

  // Coalesce consecutive vertically-stacked text regions (same column). The
  // layout model segments running text at line/paragraph granularity, but list
  // detection and wrapped-value merging need the surrounding lines as context
  // (B runs them page-wide). buildDocModel re-splits paragraphs internally, so
  // a generous merge is safe; columns never merge (no horizontal overlap).
  const merged: { region: Region; lines: OcrLine[] }[] = [];
  for (const idx of order) {
    const entry = all[idx]!;
    const prev = merged[merged.length - 1];
    const stackable =
      prev &&
      kindOf(prev.region.label) === 'text' &&
      kindOf(entry.region.label) === 'text' &&
      entry.region.box.y0 - prev.region.box.y1 < lineHeight * 2.2 &&
      hOverlapRatio(prev.region.box, entry.region.box) > 0.25;
    if (stackable) {
      prev.lines.push(...entry.lines);
      prev.region = { ...prev.region, box: unionBox([prev.region.box, entry.region.box]) };
    } else {
      merged.push({ region: entry.region, lines: [...entry.lines] });
    }
  }

  const blocks: Block[] = [];
  for (const { region, lines } of merged) {
    const kind = kindOf(region.label);
    if (kind === 'title' || kind === 'heading') {
      const text = joinedText(lines);
      if (text) blocks.push({ kind: 'heading', depth: kind === 'title' ? 1 : 2, text, box: region.box });
      continue;
    }
    if (kind === 'imageish' && !lines.length) {
      // Graphic with no legible OCR content -> placeholder per GT conventions.
      blocks.push({ kind: 'paragraph', text: '[image]', box: region.box });
      continue;
    }
    if (!lines.length) continue;
    if (kind === 'table') {
      blocks.push(...(await assembleTableRegion(lines, ocr, region, scales, runSlanet, lexiconExcluding(region))));
      continue;
    }
    // A region that is still a single line after coalescing is an isolated
    // text block by the layout model's own segmentation: it cannot be a list
    // item without an explicit bullet glyph (B's indent+lead inference needs
    // page context that a lone region does not carry — and produces false
    // single-item lists for centered/right-positioned field lines).
    if (lines.length === 1) {
      blocks.push(...singleLineBlocks(lines, ocr, scales));
      continue;
    }
    // text / imageish-with-legible-text (stamp convention): full within-region
    // assembly with heading classification disabled, at page-global scales.
    const doc = buildDocModel(regionOcr(lines, ocr), { headings: false, metrics: scales, colAnchor: 'left', lexicon });
    blocks.push(...doc.blocks);
  }
  return { blocks, width: ocr.width, height: ocr.height };
}

/**
 * Build Pipeline E's uncertainty layer: calibrated per-character OCR confidence
 * (the only within-model signal), orphan-line coverage gaps (the cross-model
 * layout-miss signal), and block→line provenance for hover-to-highlight. Orphan
 * assignment and page scales are recomputed (deterministic, cheap vs inference)
 * so this stays decoupled from buildDocModelFromRegions' string building.
 */
export function buildRegionUncertainty(
  ocr: OcrResult,
  regions: { box: BBox }[],
  doc: DocModel,
  cal: CalibrateFn,
  mode: 'isotonic' | 'identity',
): UncertaintyLayer {
  const lines = buildLineUncertainties(ocr.lines, cal);
  const lineIndex = new Map<OcrLine, number>();
  ocr.lines.forEach((l, i) => lineIndex.set(l, i));
  const assignment = assignLinesToRegions(ocr.lines, regions);
  const orphans = ocr.lines.filter((_, i) => assignment[i]! < 0);
  const clusters = synthesizeOrphanRegions(orphans, pageScales(ocr).lineHeight);
  return {
    schema: 'uncertainty/1',
    width: ocr.width,
    height: ocr.height,
    calibration: mode,
    lines,
    coverageGaps: orphanCoverageGaps(
      clusters.map((c) => ({ box: c.region.box, lineIds: c.lines.map((l) => lineIndex.get(l) ?? -1).filter((i) => i >= 0) })),
    ),
    blocks: blockProvenanceByBox(doc, lines),
    reviewItems: [],
    tableStructureConfidence: null,
  };
}
