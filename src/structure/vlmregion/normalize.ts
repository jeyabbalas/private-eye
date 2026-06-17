/**
 * VLM region markdown -> GT-convention Blocks (GROUND_TRUTH_CONVENTIONS.md).
 * Deterministic, model-agnostic glue: strips model chatter, folds unicode to
 * the GT character conventions, maps heading depth by REGION kind (the layout
 * model owns title/heading-ness in Pipeline G, exactly as in E), routes
 * "Label: value" paragraphs through the same kv detector as B/E.
 */
import type { BBox } from '../../core/types.ts';
import { parseDoc } from '../../eval/mdast.ts';
import { parseKvText, splitLead } from '../classify.ts';
import type { Block } from '../blocks.ts';
import type { RegionKind } from './replay.ts';
import { fcelTableToGrid, inlineHtmlTables } from './htmltable.ts';

const DASHES = /[‐‑‒–—―−]/g;
const CHATTER = /^(here(?:'s| is| are)\b|sure[,.!]|certainly[,.!]|below is\b|the (following|markdown|table|text) (is|shows|contains)\b|i (can|will|'ll)\b)/i;

/** Per-line unicode folding to GT conventions (NFKC, straight quotes, hyphen-
 *  minus) WITHOUT collapsing newlines (structure still matters here). */
function foldLine(s: string): string {
  return s
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"');
}

export function cleanVlmMarkdown(raw: string): string {
  let t = raw.replace(/\r\n?/g, '\n').trim();
  // Whole-answer code fence -> unwrap; stray fences -> drop the fence lines.
  const fence = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(t);
  if (fence) t = fence[1]!;
  t = t
    .split('\n')
    .filter((l) => !/^```/.test(l.trim()))
    .map(foldLine)
    .join('\n');
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  // Leading chatter line (conversational models only; OCR-tuned models don't chat).
  const lines = t.split('\n');
  while (lines.length && (CHATTER.test(lines[0]!.trim()) || lines[0]!.trim() === '')) lines.shift();
  // Bullet glyph folding to '-'.
  return lines
    .map((l) => l.replace(/^(\s*)[•◦·▪‣*+](\s+)/, '$1-$2'))
    .join('\n')
    .trim();
}

/** Flatten any markdown/HTML to one plain-text line (for heading regions). */
function flatText(md: string): string {
  return parseDoc(inlineHtmlTables(md))
    .map((b) => (b.type === 'table' ? b.grid.flat().join(' ') : b.type === 'thematicBreak' ? '' : b.text))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapTextBlocks(md: string, box: BBox, intraHeadingDepth: 1 | 2 | 3): Block[] {
  const out: Block[] = [];
  for (const b of parseDoc(inlineHtmlTables(md))) {
    switch (b.type) {
      case 'heading': {
        const text = b.text.trim();
        if (text) out.push({ kind: 'heading', depth: intraHeadingDepth, text, box });
        break;
      }
      case 'paragraph': {
        const text = b.text.trim();
        if (!text) break;
        if (text === '[image]' || text === '[signature]') {
          out.push({ kind: 'paragraph', text, box });
          break;
        }
        const kv = parseKvText(text);
        if (kv.isKv) out.push({ kind: 'kv', label: kv.label!, value: kv.value!, box });
        else out.push({ kind: 'paragraph', text, box });
        break;
      }
      case 'listItem': {
        const text = b.text.trim();
        if (!text) break;
        const lead = splitLead(text);
        out.push({ kind: 'listItem', ...(lead.lead ? { lead: lead.lead } : {}), text: lead.text, box });
        break;
      }
      case 'table':
        if (b.grid.length && b.grid.some((r) => r.some((c) => c.trim()))) out.push({ kind: 'table', cells: b.grid, box });
        break;
      case 'thematicBreak':
        out.push({ kind: 'rule', box });
        break;
    }
  }
  return out;
}

/**
 * Region markdown -> Blocks, dispatched by region kind. Returns null when the
 * output is unusable for that kind (caller falls back to the OCR path).
 *  - title/heading: ONE heading block (depth 1/2 by kind), text flattened.
 *  - table: first table grid (HTML or GFM); a leading non-table line becomes a
 *    paragraph before it.
 *  - text/imageish-with-lines: full block mapping; the VLM's own intra-region
 *    headings demote to depth 3 (GT sub-heading convention).
 *  - page (full-page baseline): block mapping with the VLM's own depths kept.
 */
export function vlmRegionToBlocks(raw: string, kind: RegionKind | 'page', box: BBox): Block[] | null {
  const clean = cleanVlmMarkdown(raw);
  if (!clean) return null;

  if (kind === 'title' || kind === 'heading') {
    const text = flatText(clean);
    if (!text) return null;
    return [{ kind: 'heading', depth: kind === 'title' ? 1 : 2, text, box }];
  }

  if (kind === 'table') {
    // PaddleOCR-VL's <fcel> dialect first (not HTML/GFM).
    const fcel = fcelTableToGrid(clean);
    if (fcel) return [{ kind: 'table', cells: fcel, box }];
    const blocks = mapTextBlocks(clean, box, 3);
    const ti = blocks.findIndex((b) => b.kind === 'table');
    if (ti < 0) return null;
    // Keep at most one leading line (a swallowed heading/caption) + the table.
    const lead = blocks
      .slice(0, ti)
      .filter((b) => b.kind === 'heading' || b.kind === 'paragraph' || b.kind === 'kv')
      .slice(0, 1);
    return [...lead, blocks[ti]!];
  }

  if (kind === 'page') {
    const blocks = parseDoc(inlineHtmlTables(clean));
    const out: Block[] = [];
    for (const b of blocks) {
      if (b.type === 'heading') {
        const d = Math.min(3, Math.max(1, b.depth)) as 1 | 2 | 3;
        if (b.text.trim()) out.push({ kind: 'heading', depth: d, text: b.text.trim(), box });
      } else {
        out.push(...mapTextBlocksSingle(b, box));
      }
    }
    return out.length ? out : null;
  }

  const blocks = mapTextBlocks(clean, box, 3);
  return blocks.length ? blocks : null;
}

/** Map one already-parsed DocBlock (page mode reuses paragraph/list/table rules). */
function mapTextBlocksSingle(b: ReturnType<typeof parseDoc>[number], box: BBox): Block[] {
  switch (b.type) {
    case 'paragraph': {
      const text = b.text.trim();
      if (!text) return [];
      const kv = parseKvText(text);
      return kv.isKv ? [{ kind: 'kv', label: kv.label!, value: kv.value!, box }] : [{ kind: 'paragraph', text, box }];
    }
    case 'listItem': {
      const text = b.text.trim();
      if (!text) return [];
      const lead = splitLead(text);
      return [{ kind: 'listItem', ...(lead.lead ? { lead: lead.lead } : {}), text: lead.text, box }];
    }
    case 'table':
      return b.grid.length && b.grid.some((r) => r.some((c) => c.trim())) ? [{ kind: 'table', cells: b.grid, box }] : [];
    case 'thematicBreak':
      return [{ kind: 'rule', box }];
    default:
      return [];
  }
}
