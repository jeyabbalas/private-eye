/**
 * The linked Markdown editor: the working document rendered block-by-block, each
 * block tagged with its uid so it can be highlighted, scrolled to, edited, or
 * removed independently. Hovering a block lights its region on the scan; clicking
 * Edit swaps in a textarea over the block's raw Markdown fragment, and saving emits
 * a reversible text-edit. The model is the source; this is its projection — so
 * editing a fragment and re-joining stays byte-faithful.
 *
 * Review lives inline here, not in a side panel: each flagged spot becomes an inline
 * highlight on the exact token (when there is one) plus a numbered "book-tab" in the
 * left gutter — the worklist made visible against the text it concerns. Tabs and
 * highlights cross-light with the scan region in both directions.
 */
import { mdToHtml } from '../runtime/markdown.ts';
import type { BBox } from '../core/types.ts';
import type { WorkingBlock } from './corrections.ts';

/** One flagged spot, projected onto the Markdown. */
export interface BlockAnnotation {
  /** Attention item id. */
  id: string;
  /** 1-based worklist position (shown on the book-tab). */
  number: number;
  /** Block to attach the tab to — the item's own block, or the nearest one. */
  uid: string;
  severity: 'attention' | 'caution';
  /** True when the item belongs to this block (so we mark/tint it); false when the
   *  block is only the nearest anchor for a region-level item. */
  inThisBlock: boolean;
  /** Exact substring to highlight inline (only meaningful when `inThisBlock`). */
  token?: string;
}

export interface EditorHandle {
  readonly el: HTMLElement;
  render(blocks: WorkingBlock[]): void;
  /** Project the worklist onto the document (inline marks + gutter book-tabs). */
  setAnnotations(anns: BlockAnnotation[]): void;
  /** Scroll a block into view and flash it (driven by the worklist stepper). */
  focusBlock(uid: string): void;
  /** Cross-light one attention item (its tab + inline mark + linked block). */
  highlightItem(id: string | null): void;
  /** Cross-light a whole block + its tabs (driven by scan-region hover). */
  highlightBlock(uid: string | null): void;
}

export interface EditorOptions {
  onEdit: (uid: string, markdown: string) => void;
  onRemove: (uid: string) => void;
  /** Hover a block ↔ highlight its page region (null on leave). */
  onHover: (box: BBox | null) => void;
  /** Click a book-tab / inline mark ↔ open its actions, anchored to the element. */
  onItemActivate: (id: string, anchor: HTMLElement) => void;
  /** Hover a book-tab / inline mark ↔ cross-light (null on leave). */
  onItemHover: (id: string | null) => void;
}

interface Entry {
  wrap: HTMLElement;
  view: HTMLElement;
  block: WorkingBlock;
  baseHtml: string;
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const el = document.createElement('div');
  el.className = 'pe-editor';

  const entries = new Map<string, Entry>();
  const tabByItem = new Map<string, HTMLElement>();
  const markByItem = new Map<string, HTMLElement>();
  const blockByItem = new Map<string, string>();
  const itemsByBlock = new Map<string, string[]>();
  let lastAnns: BlockAnnotation[] = [];
  let activeItem: string | null = null;
  let activeBlock: string | null = null;

  const render = (blocks: WorkingBlock[]): void => {
    entries.clear();
    tabByItem.clear();
    markByItem.clear();
    blockByItem.clear();
    itemsByBlock.clear();
    activeItem = activeBlock = null;
    if (!blocks.length) {
      el.innerHTML = '<div class="pe-editor-empty">Nothing was read on this page.</div>';
      return;
    }
    el.replaceChildren(...blocks.map((b) => buildBlock(b)));
  };

  function buildBlock(block: WorkingBlock): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = `pe-block pe-block-${block.kind}${block.added ? ' pe-block-added' : ''}`;
    wrap.dataset.uid = block.uid;

    const view = document.createElement('div');
    view.className = 'pe-block-view pe-rendered';
    const baseHtml = mdToHtml(block.markdown);
    view.innerHTML = baseHtml;

    const tools = document.createElement('div');
    tools.className = 'pe-block-tools';
    tools.append(
      toolBtn('Edit', () => enterEdit()),
      toolBtn('Remove', () => opts.onRemove(block.uid)),
    );

    wrap.append(view, tools);
    entries.set(block.uid, { wrap, view, block, baseHtml });

    wrap.addEventListener('mouseenter', () => opts.onHover(block.box));
    wrap.addEventListener('mouseleave', () => opts.onHover(null));
    view.addEventListener('dblclick', () => enterEdit());

    function enterEdit(): void {
      if (wrap.classList.contains('pe-block-editing')) return;
      wrap.classList.add('pe-block-editing');

      const ta = document.createElement('textarea');
      ta.className = 'pe-block-input';
      ta.value = block.markdown;
      ta.rows = Math.min(14, Math.max(2, block.markdown.split('\n').length));

      const bar = document.createElement('div');
      bar.className = 'pe-block-editbar';
      const save = toolBtn('Save', () => commit());
      save.classList.add('pe-att-btn-primary');
      bar.append(save, toolBtn('Cancel', () => cancel()));

      const editor = document.createElement('div');
      editor.className = 'pe-block-edit';
      editor.append(ta, bar);
      wrap.replaceChildren(editor);
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);

      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          commit();
        }
      });

      function commit(): void {
        const next = ta.value.replace(/\s+$/, '');
        if (next !== block.markdown) opts.onEdit(block.uid, next);
        else cancel(); // unchanged — just restore the view (no event, no re-render)
      }
      function cancel(): void {
        wrap.classList.remove('pe-block-editing');
        view.innerHTML = entries.get(block.uid)?.baseHtml ?? view.innerHTML;
        wrap.replaceChildren(view, tools);
        applyAnnotations(lastAnns); // restore tabs/marks the edit view replaced
      }
    }

    return wrap;
  }

  /** (Re)project the worklist onto the document. Idempotent: resets every block's
   *  view to its base HTML first, then re-marks — so a τ change never accretes. */
  function applyAnnotations(anns: BlockAnnotation[]): void {
    lastAnns = anns;
    el.querySelectorAll('.pe-booktab').forEach((n) => n.remove());
    tabByItem.clear();
    markByItem.clear();
    blockByItem.clear();
    itemsByBlock.clear();
    activeItem = activeBlock = null;

    for (const { wrap, view, baseHtml } of entries.values()) {
      if (wrap.classList.contains('pe-block-editing')) continue;
      view.innerHTML = baseHtml;
      wrap.classList.remove('pe-block-flagged-attention', 'pe-block-flagged-caution', 'pe-block-linked');
    }

    for (const ann of anns) {
      blockByItem.set(ann.id, ann.uid);
      const list = itemsByBlock.get(ann.uid) ?? [];
      list.push(ann.id);
      itemsByBlock.set(ann.uid, list);

      const entry = entries.get(ann.uid);
      if (!entry || entry.wrap.classList.contains('pe-block-editing')) continue;

      if (ann.inThisBlock) {
        const mark = ann.token ? markFirst(entry.view, ann.token, ann.severity, ann.id) : null;
        if (mark) {
          markByItem.set(ann.id, mark);
          wireSpot(mark, ann.id);
        } else {
          entry.wrap.classList.add(`pe-block-flagged-${ann.severity}`);
        }
      }

      const tab = document.createElement('button');
      tab.className = `pe-booktab pe-booktab-${ann.severity}`;
      tab.dataset.itemId = ann.id;
      tab.textContent = String(ann.number);
      tab.title = `Spot ${ann.number} — show on the scan`;
      tab.setAttribute('aria-label', `Flagged spot ${ann.number}`);
      tab.style.top = `${4 + (list.length - 1) * 22}px`;
      wireSpot(tab, ann.id);
      entry.wrap.appendChild(tab);
      tabByItem.set(ann.id, tab);
    }
  }

  function wireSpot(node: HTMLElement, id: string): void {
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onItemActivate(id, node);
    });
    node.addEventListener('mouseenter', () => opts.onItemHover(id));
    node.addEventListener('mouseleave', () => opts.onItemHover(null));
  }

  function setActiveItem(id: string | null): void {
    if (activeItem === id) return;
    if (activeItem) {
      tabByItem.get(activeItem)?.classList.remove('pe-spot-active');
      markByItem.get(activeItem)?.classList.remove('pe-spot-active');
      const u = blockByItem.get(activeItem);
      if (u) entries.get(u)?.wrap.classList.remove('pe-block-linked');
    }
    activeItem = id;
    if (id) {
      tabByItem.get(id)?.classList.add('pe-spot-active');
      markByItem.get(id)?.classList.add('pe-spot-active');
      const u = blockByItem.get(id);
      if (u) entries.get(u)?.wrap.classList.add('pe-block-linked');
    }
  }

  function setActiveBlock(uid: string | null): void {
    if (activeBlock === uid) return;
    if (activeBlock) {
      entries.get(activeBlock)?.wrap.classList.remove('pe-block-linked');
      for (const id of itemsByBlock.get(activeBlock) ?? []) tabByItem.get(id)?.classList.remove('pe-spot-active');
    }
    activeBlock = uid;
    if (uid) {
      entries.get(uid)?.wrap.classList.add('pe-block-linked');
      for (const id of itemsByBlock.get(uid) ?? []) tabByItem.get(id)?.classList.add('pe-spot-active');
    }
  }

  return {
    el,
    render,
    setAnnotations: applyAnnotations,
    focusBlock(uid) {
      const node = entries.get(uid)?.wrap;
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.remove('pe-block-flash');
      void node.offsetWidth; // reflow so the animation restarts
      node.classList.add('pe-block-flash');
    },
    highlightItem: setActiveItem,
    highlightBlock: setActiveBlock,
  };
}

/** Wrap the first occurrence of `token` (outside any existing mark) in a span. */
function markFirst(root: HTMLElement, token: string, severity: string, id: string): HTMLElement | null {
  const needle = token.trim();
  if (!needle) return null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('.pe-hl') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const i = node.data.indexOf(needle);
    if (i < 0) continue;
    const after = node.splitText(i);
    after.splitText(needle.length);
    const mark = document.createElement('span');
    mark.className = `pe-hl pe-hl-${severity}`;
    mark.dataset.itemId = id;
    mark.textContent = after.data;
    after.replaceWith(mark);
    return mark;
  }
  return null;
}

function toolBtn(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'pe-att-btn';
  b.textContent = label;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
