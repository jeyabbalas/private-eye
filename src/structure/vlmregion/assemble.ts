/**
 * Pipeline G document builder (pure replay): exported regions/OCR + per-region
 * VLM markdown -> DocModel. Reuses Pipeline E's exported helpers wherever the
 * logic is not VLM-specific (orphan synthesis, page scales, the table
 * grid-vs-table discriminator with B's heuristic floor); VLM-derived blocks are
 * numerically anchored before emission.
 *
 * gmode:
 *  - 'full'        headline G: every decodable region uses VLM content;
 *  - 'tables-only' escalation simulation: OCR assembly everywhere, VLM only
 *                  for table regions (the proposal's recommended variant);
 *  - 'page'        full-page baseline (Qwen3-VL): one whole-page decode.
 */
import { distance } from 'fastest-levenshtein';
import type { BBox, OcrLine, OcrResult } from '../../core/types.ts';
import { hOverlapRatio, unionBox, vOverlapRatio } from '../../core/types.ts';
import { buildDocModel } from '../assemble.ts';
import { assembleTableRegion, pageScales, synthesizeOrphanRegions, type PageScales, type Region } from '../region-assemble.ts';
import { parseKvText } from '../classify.ts';
import type { Block, DocModel } from '../blocks.ts';
import type { UncertaintyLayer } from '../uncertainty.ts';
import { blockProvenanceByBox, buildLineUncertainties, identityCalibrate, orphanCoverageGaps } from '../uncertainty-build.ts';
import { verifyPage, type VerificationResult } from '../verify.ts';
import { vlmRegionToBlocks } from './normalize.ts';
import { NumberPool, anchorBlocks, emptyAnchorStats, type AnchorPolicy, type AnchorStats } from './anchor.ts';
import type { ExportLine, ExportPage, ExportRegion, VlmRegionOut } from './replay.ts';

export type GMode = 'full' | 'tables-only' | 'page';

export interface GAssembleOptions {
  gmode: GMode;
  anchor: AnchorPolicy;
  /** Optional, default off: emit a low-severity 'disagree-text' review item per
   *  region where the VLM prose diverges far from the OCR reading (the VLM is
   *  preferred for prose, so this never alters text — it is only a review hint). */
  flagTextDisagreement?: boolean;
}

export interface GAssembleStats {
  regions: number;
  vlmUsed: number;
  gridRouted: number;
  tableFallback: number;
  ocrFallback: number;
  anchor: AnchorStats;
}

const toLine = (l: ExportLine): OcrLine => ({ text: l.text, conf: l.conf, box: l.box });

/** Region-level VLM-vs-OCR prose disagreement threshold (normalized Levenshtein
 *  similarity below this → flag for optional review). */
const TEXT_DISAGREE_SIM = 0.75;
const normText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Concatenated text of (anchored) VLM blocks, for the prose-disagreement check. */
function blocksText(blocks: Block[]): string {
  return blocks
    .map((b) => {
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
        default:
          return '';
      }
    })
    .join(' ');
}

function joinedText(lines: OcrLine[]): string {
  return [...lines]
    .sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)
    .map((l) => l.text.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Emit a low-severity review hint when a region's VLM prose diverges far from its
 *  OCR reading. Region-scoped (prose disagreement is fuzzy) and text-preserving. */
function flagTextDisagreement(regionLines: OcrLine[], vlmBlocks: Block[], region: number, regBox: BBox, blockIndex: number, stats: AnchorStats): void {
  const ocrText = joinedText(regionLines);
  const vlmText = blocksText(vlmBlocks);
  if (!ocrText || !vlmText) return;
  const a = normText(ocrText);
  const b = normText(vlmText);
  const sim = 1 - distance(a, b) / Math.max(a.length, b.length, 1);
  if (sim >= TEXT_DISAGREE_SIM) return;
  stats.events.push({
    kind: 'disagree-text',
    regionIndex: region,
    blockIndex,
    box: regBox,
    charStart: 0,
    charEnd: vlmText.length,
    ocrReading: ocrText,
    vlmReading: vlmText,
    severity: 'low',
  });
}

/** OCR-only assembly of a line bucket (the per-region fallback floor — B/E's
 *  shared multi-line path; single lines route through the kv detector). */
function ocrTextBlocks(lines: OcrLine[], ocr: OcrResult, scales: PageScales): Block[] {
  if (!lines.length) return [];
  if (lines.length === 1) {
    const text = lines[0]!.text.replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const kv = parseKvText(text);
    if (kv.isKv) return [{ kind: 'kv', label: kv.label!, value: kv.value!, box: lines[0]!.box }];
    return [{ kind: 'paragraph', text, box: lines[0]!.box }];
  }
  const sub: OcrResult = { lines, width: ocr.width, height: ocr.height, engineId: ocr.engineId };
  return buildDocModel(sub, { headings: false, metrics: scales, colAnchor: 'left' }).blocks;
}

type Entry =
  | { synth: false; reg: ExportRegion; lines: OcrLine[] }
  | { synth: true; region: Region; lines: OcrLine[] };

/** E's learned-order splice for synthetic (orphan) regions, verbatim semantics. */
function spliceSynthetics(real: Entry[], synths: Entry[]): Entry[] {
  const order: Entry[] = [...real];
  for (const s of synths) {
    const first = [...s.lines].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0)[0];
    const fBox = first?.box ?? (s as { region: Region }).region.box;
    const fCy = (fBox.y0 + fBox.y1) / 2;
    let pos = order.findIndex((e) => {
      if (e.synth) return false;
      const rb = e.reg.box;
      if (vOverlapRatio(fBox, rb) > 0.3) return rb.x0 > fBox.x0;
      return (rb.y0 + rb.y1) / 2 > fCy;
    });
    if (pos < 0) pos = order.length;
    order.splice(pos, 0, s);
  }
  return order;
}

export async function buildDocFromReplay(
  page: ExportPage,
  vlmByKey: Map<string, VlmRegionOut>,
  opts: GAssembleOptions,
): Promise<{ doc: DocModel; stats: GAssembleStats; vlmMsUsed: number; uncertainty: UncertaintyLayer; verification: VerificationResult }> {
  const stats: GAssembleStats = { regions: page.regions.length, vlmUsed: 0, gridRouted: 0, tableFallback: 0, ocrFallback: 0, anchor: emptyAnchorStats() };
  // Keep one set of line objects so lineIds are stable across the uncertainty
  // layer (buildLineUncertainties) and the coverage gaps (orphan clusters).
  const regionLines: OcrLine[] = page.regions.flatMap((r) => r.lines.map(toLine));
  const orphanLines: OcrLine[] = page.orphanLines.map(toLine);
  const allLines: OcrLine[] = [...regionLines, ...orphanLines];
  const lineIndex = new Map<OcrLine, number>();
  allLines.forEach((l, i) => lineIndex.set(l, i));
  const ocr: OcrResult = { lines: allLines, width: page.width, height: page.height, engineId: 'g-replay' };
  const scales = pageScales(ocr);
  const orphanClusters = synthesizeOrphanRegions(orphanLines, scales.lineHeight);
  const pool = new NumberPool(
    page.regions.map((r) => ({ index: r.index, lines: r.lines })),
    page.orphanLines,
  );
  let vlmMsUsed = 0;

  // Uncertainty layer (cross-model signal): per-line OCR confidence (region-level
  // context — chars are empty since the replay export carries no per-char data),
  // orphan-line coverage gaps, numeric disagreement events, and block provenance.
  const buildLayer = (doc: DocModel): UncertaintyLayer => {
    const lines = buildLineUncertainties(allLines, identityCalibrate);
    return {
      schema: 'uncertainty/1',
      width: page.width,
      height: page.height,
      calibration: 'identity',
      lines,
      coverageGaps: orphanCoverageGaps(
        orphanClusters.map((c) => ({ box: c.region.box, lineIds: c.lines.map((l) => lineIndex.get(l) ?? -1).filter((i) => i >= 0) })),
      ),
      blocks: blockProvenanceByBox(doc, lines),
      reviewItems: stats.anchor.events,
      tableStructureConfidence: null,
    };
  };

  // Anchor a region's blocks and convert each event's local block index to the
  // page-level DocModel.blocks index (events are pushed during the call).
  const anchorInto = (toAnchor: Block[], region: number): Block[] => {
    const base = blocks.length;
    const evBase = stats.anchor.events.length;
    const res = anchorBlocks(toAnchor, region, pool, opts.anchor, stats.anchor);
    for (let k = evBase; k < stats.anchor.events.length; k++) stats.anchor.events[k]!.blockIndex += base;
    return res;
  };

  // --- full-page baseline ---
  if (opts.gmode === 'page') {
    const out = vlmByKey.get('page');
    const pageBox = { x0: 0, y0: 0, x1: page.width, y1: page.height };
    const pageBlocks = out?.outputMd ? (vlmRegionToBlocks(out.outputMd, 'page', pageBox) ?? []) : [];
    if (out?.outputMd) {
      vlmMsUsed = out.ms;
      stats.vlmUsed = 1;
    } else {
      stats.ocrFallback = 1;
    }
    // Single array built then anchored in place → local block index == final index.
    anchorBlocks(pageBlocks, -999, pool, opts.anchor, stats.anchor);
    const doc: DocModel = { blocks: pageBlocks, width: page.width, height: page.height };
    const uncertainty = buildLayer(doc);
    return { doc, stats, vlmMsUsed, uncertainty, verification: verifyPage({ doc, ocr, uncertainty }) };
  }

  // --- per-region modes ---
  const real: Entry[] = page.regions.map((reg) => ({ synth: false, reg, lines: reg.lines.map(toLine) }));
  const synths: Entry[] = orphanClusters.map((s) => ({ synth: true, region: s.region, lines: s.lines }));
  let entries = spliceSynthetics(real, synths);

  // Escalation mode mimics E: coalesce consecutive stacked text entries (the
  // VLM never sees these, so merging is safe and matches E's list handling).
  if (opts.gmode === 'tables-only') {
    const merged: Entry[] = [];
    for (const e of entries) {
      const prev = merged[merged.length - 1];
      const kind = e.synth ? 'text' : e.reg.kind;
      const prevKind = !prev ? null : prev.synth ? 'text' : prev.reg.kind;
      const box = e.synth ? e.region.box : e.reg.box;
      const prevBox = !prev ? null : prev.synth ? prev.region.box : prev.reg.box;
      if (prev && prevKind === 'text' && kind === 'text' && prevBox && box.y0 - prevBox.y1 < scales.lineHeight * 2.2 && hOverlapRatio(prevBox, box) > 0.25) {
        prev.lines.push(...e.lines);
        if (prev.synth) prev.region = { ...prev.region, box: unionBox([prevBox, box]) };
        else prev.reg = { ...prev.reg, box: unionBox([prevBox, box]) };
      } else {
        merged.push(e.synth ? { ...e, lines: [...e.lines] } : { ...e, lines: [...e.lines] });
      }
    }
    entries = merged;
  }

  const blocks: Block[] = [];
  for (const e of entries) {
    if (e.synth) {
      blocks.push(...ocrTextBlocks(e.lines, ocr, scales));
      continue;
    }
    const reg = e.reg;
    const region: Region = { label: reg.label, score: reg.score, box: reg.box, orderRank: reg.orderRank };
    const out = vlmByKey.get(reg.regionKey);
    const usable = !!out?.outputMd && !out.error && !out.timedOut;

    if (reg.kind === 'imageish' && !e.lines.length) {
      blocks.push({ kind: 'paragraph', text: '[image]', box: reg.box });
      continue;
    }

    if (reg.kind === 'table' && e.lines.length) {
      // E's discriminator first: a layout-mislabelled field grid stays kv.
      const eBlocks = await assembleTableRegion(e.lines, ocr, region, scales, undefined);
      if (eBlocks.some((b) => b.kind === 'kv')) {
        stats.gridRouted++;
        blocks.push(...eBlocks);
        continue;
      }
      const tableUsable = usable && !out!.truncated && !out!.repetition;
      const vlmBlocks = tableUsable ? vlmRegionToBlocks(out!.outputMd!, 'table', reg.box) : null;
      if (vlmBlocks) {
        stats.vlmUsed++;
        vlmMsUsed += out!.ms;
        const base = blocks.length;
        blocks.push(...anchorInto(vlmBlocks, reg.index));
        if (opts.flagTextDisagreement) flagTextDisagreement(e.lines, vlmBlocks, reg.index, reg.box, base, stats.anchor);
      } else {
        stats.tableFallback++;
        blocks.push(...eBlocks); // E's heuristic floor
      }
      continue;
    }

    const wantVlm = opts.gmode === 'full';
    if (wantVlm && usable) {
      // Truncated/repetition text is still partial signal for TEXT kinds; the
      // events themselves are counted Python-side as bake-off telemetry.
      const vlmBlocks = vlmRegionToBlocks(out!.outputMd!, reg.kind, reg.box);
      if (vlmBlocks) {
        stats.vlmUsed++;
        vlmMsUsed += out!.ms;
        const base = blocks.length;
        blocks.push(...anchorInto(vlmBlocks, reg.index));
        if (opts.flagTextDisagreement) flagTextDisagreement(e.lines, vlmBlocks, reg.index, reg.box, base, stats.anchor);
        continue;
      }
    }
    if (wantVlm) stats.ocrFallback++;
    if (reg.kind === 'title' || reg.kind === 'heading') {
      const text = joinedText(e.lines);
      if (text) blocks.push({ kind: 'heading', depth: reg.kind === 'title' ? 1 : 2, text, box: reg.box });
    } else {
      blocks.push(...ocrTextBlocks(e.lines, ocr, scales));
    }
  }

  const doc: DocModel = { blocks, width: page.width, height: page.height };
  const uncertainty = buildLayer(doc);
  return { doc, stats, vlmMsUsed, uncertainty, verification: verifyPage({ doc, ocr, uncertainty }) };
}
