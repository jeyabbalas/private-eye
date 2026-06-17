/** The engine-agnostic document model + Markdown serializer (per GROUND_TRUTH_CONVENTIONS.md). */
import type { BBox } from '../core/types.ts';

export type Block =
  | { kind: 'heading'; depth: 1 | 2 | 3; text: string; box: BBox }
  | { kind: 'paragraph'; text: string; box: BBox }
  | { kind: 'listItem'; lead?: string; text: string; box: BBox }
  | { kind: 'kv'; label: string; value: string; box: BBox }
  | { kind: 'table'; cells: string[][]; box: BBox }
  | { kind: 'rule'; box: BBox };

export interface DocModel {
  blocks: Block[];
  width: number;
  height: number;
}

function renderTable(cells: string[][]): string {
  if (!cells.length) return '';
  const cols = Math.max(...cells.map((r) => r.length));
  const pad = (row: string[]) => {
    const r = [...row];
    while (r.length < cols) r.push('');
    return r;
  };
  const head = pad(cells[0]!);
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const row of cells.slice(1)) lines.push(`| ${pad(row).join(' | ')} |`);
  return lines.join('\n');
}

/** Serialize a DocModel to Markdown. Adjacent kv/list blocks are kept tight; a
 *  blank line separates structurally distinct blocks. */
export function renderMarkdown(doc: DocModel): string {
  const out: string[] = [];
  let prevKind: Block['kind'] | null = null;

  for (const b of doc.blocks) {
    const tightWithPrev =
      (b.kind === 'kv' && prevKind === 'kv') || (b.kind === 'listItem' && prevKind === 'listItem');
    if (out.length && !tightWithPrev) out.push('');

    switch (b.kind) {
      case 'heading':
        out.push(`${'#'.repeat(b.depth)} ${b.text}`);
        break;
      case 'paragraph':
        out.push(b.text);
        break;
      case 'listItem':
        out.push(`- ${b.lead ? `**${b.lead}:** ` : ''}${b.text}`);
        break;
      case 'kv':
        out.push(`**${b.label}:** ${b.value}`);
        break;
      case 'table':
        out.push(renderTable(b.cells));
        break;
      case 'rule':
        out.push('---');
        break;
    }
    prevKind = b.kind;
  }
  return out.join('\n') + '\n';
}
