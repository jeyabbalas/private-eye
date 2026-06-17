/**
 * Pipeline G (bake-off) replay contracts: the JSON shapes shared by
 * scripts/export-regions.ts (writer), bakeoff/run.py (reader/writer — keep in
 * sync by hand, Python side), and the 'vlm' replay adapter (reader).
 *
 * Bake-off discipline: the export is the single source of truth for regions and
 * OCR; the adapter never re-runs engines, so a stale replay can never silently
 * impersonate a live result — key mismatches throw (see parse helpers).
 */
import type { BBox } from '../../core/types.ts';

export type RegionKind = 'title' | 'heading' | 'table' | 'imageish' | 'text';

/** Duplicate of region-assemble's private KIND map (kept local so the bake-off
 *  touches zero Pipeline E code; revisit if G graduates past bake-off). */
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
export const kindOf = (label: string): RegionKind => KIND[label] ?? 'text';

/** Stable key of a layout region: label + integer-rounded page box, FNV-1a 32-bit
 *  hex. Survives cosmetic float jitter; real drift (ORT/threshold change between
 *  export and replay) mismatches loudly and forces a re-export. */
export function regionKey(label: string, box: BBox): string {
  const s = `${label}@${Math.round(box.x0)},${Math.round(box.y0)},${Math.round(box.x1)},${Math.round(box.y1)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface ExportLine {
  text: string;
  conf: number;
  box: BBox;
}

export interface ExportRegion {
  index: number;
  regionKey: string;
  label: string;
  kind: RegionKind;
  score: number;
  orderRank: number;
  box: BBox;
  /** Padded+clamped integer crop rect actually written to cropPng (null when skipped). */
  cropBox: BBox | null;
  cropPng: string | null;
  skipped: 'imageish-no-text' | 'too-small' | null;
  /** OCR lines assigned to this region (assignLinesToRegions semantics). */
  lines: ExportLine[];
}

export interface ExportPage {
  schema: 'g-regions/1';
  tag: string; // e.g. "sample1.001"
  fixture: string;
  page: number;
  sourcePng: string;
  width: number;
  height: number;
  opts: Record<string, number | string>;
  stageMs: { layout: number; det: number; rec: number };
  /** Layout+det+rec asset bytes (G's deterministic-stage download footprint). */
  engineBytes: number;
  regions: ExportRegion[];
  /** OCR lines no region claimed (assigned -1); always emitted by the adapter. */
  orphanLines: ExportLine[];
}

export interface VlmRegionOut {
  index: number;
  regionKey: string;
  ms: number;
  tokensOut?: number;
  outputMd: string | null;
  truncated?: boolean;
  repetition?: boolean;
  timedOut?: boolean;
  error?: string | null;
}

export interface VlmReplayFile {
  schema: 'g-vlm-replay/1';
  tag: string;
  model: string;
  modelId?: string;
  revision?: string;
  promptRev?: string;
  device?: string;
  pageMs?: number;
  regions: VlmRegionOut[];
}

export interface BakeoffModelMeta {
  model: string;
  modelId: string;
  revision?: string;
  totalBytes: number;
}

function parseJson(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new Error(`${what}: invalid JSON (${(err as Error).message})`);
  }
}

export function parseExportPage(bytes: Uint8Array, expectTag: string): ExportPage {
  const p = parseJson(bytes, `regions ${expectTag}`) as ExportPage;
  if (p.schema !== 'g-regions/1') throw new Error(`regions ${expectTag}: schema ${String(p.schema)} != g-regions/1`);
  if (p.tag !== expectTag) throw new Error(`regions file tag ${p.tag} != ${expectTag}`);
  if (!Array.isArray(p.regions)) throw new Error(`regions ${expectTag}: missing regions[]`);
  return p;
}

/** Parse + cross-check a VLM replay file against the export it claims to cover.
 *  Any region-set drift throws: replay/infra failures must be loud. */
export function parseReplayFile(bytes: Uint8Array, exportPage: ExportPage, model: string): VlmReplayFile {
  const tag = exportPage.tag;
  const r = parseJson(bytes, `vlm replay ${model}/${tag}`) as VlmReplayFile;
  if (r.schema !== 'g-vlm-replay/1') throw new Error(`vlm replay ${tag}: schema ${String(r.schema)} != g-vlm-replay/1`);
  if (r.tag !== tag) throw new Error(`vlm replay tag ${r.tag} != ${tag}`);
  if (!Array.isArray(r.regions)) throw new Error(`vlm replay ${tag}: missing regions[]`);
  const want = new Set(exportPage.regions.map((x) => x.regionKey));
  const got = new Set(r.regions.map((x) => x.regionKey));
  const missing = [...want].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !want.has(k));
  if (missing.length || extra.length) {
    throw new Error(
      `vlm replay ${model}/${tag}: regionKey mismatch (stale export?) missing=[${missing.join(',')}] extra=[${extra.join(',')}] — re-run export + bakeoff`,
    );
  }
  return r;
}

export function replayByKey(r: VlmReplayFile): Map<string, VlmRegionOut> {
  return new Map(r.regions.map((x) => [x.regionKey, x]));
}
