/**
 * Parse Markdown into an ordered list of semantic blocks with plain text,
 * shared by all metrics so they agree on what a "block" and a "table" are.
 */
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import type { Nodes, RootContent } from 'mdast';
import { normalizeText } from './normalize.ts';

export type DocBlock =
  | { type: 'heading'; depth: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'listItem'; text: string }
  | { type: 'table'; grid: string[][] }
  | { type: 'thematicBreak' };

/** Recursively collect inline text from an mdast node. */
function inlineText(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'break':
      return ' ';
    case 'image':
      return node.alt ?? '';
    default: {
      const kids = 'children' in node ? node.children : [];
      return kids.map((c) => inlineText(c)).join('');
    }
  }
}

function cellText(node: Nodes): string {
  return normalizeText(inlineText(node));
}

export function parseDoc(md: string): DocBlock[] {
  const tree = fromMarkdown(md, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const blocks: DocBlock[] = [];

  const walk = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'heading':
          blocks.push({ type: 'heading', depth: node.depth, text: normalizeText(inlineText(node)) });
          break;
        case 'paragraph':
          blocks.push({ type: 'paragraph', text: normalizeText(inlineText(node)) });
          break;
        case 'thematicBreak':
          blocks.push({ type: 'thematicBreak' });
          break;
        case 'list':
          for (const item of node.children) {
            // One block per list item; flatten nested lists into separate items.
            const directText: string[] = [];
            const nestedLists: RootContent[] = [];
            for (const child of item.children) {
              if (child.type === 'list') nestedLists.push(child);
              else directText.push(normalizeText(inlineText(child)));
            }
            blocks.push({ type: 'listItem', text: directText.join(' ').trim() });
            if (nestedLists.length) walk(nestedLists);
          }
          break;
        case 'table': {
          const grid = node.children.map((row) => row.children.map((c) => cellText(c)));
          blocks.push({ type: 'table', grid });
          break;
        }
        default:
          // blockquote, code, html, etc.: descend if it has block children
          if ('children' in node) walk(node.children as RootContent[]);
      }
    }
  };
  walk(tree.children);
  return blocks;
}

/** Linearize a table grid to row-major text (used for CER / reading order). */
export function tableToText(grid: string[][]): string {
  return grid.map((row) => row.join(' ')).join(' ');
}

/** Plain text of a block (tables linearized). */
export function blockText(b: DocBlock): string {
  switch (b.type) {
    case 'table':
      return tableToText(b.grid);
    case 'thematicBreak':
      return '';
    default:
      return b.text;
  }
}

/** Full document plain text in reading order (markdown stripped). */
export function docToText(blocks: DocBlock[]): string {
  return blocks
    .map(blockText)
    .filter((t) => t.length > 0)
    .join('\n');
}
