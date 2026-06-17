/**
 * The linked Markdown editor: the working document rendered block-by-block, each
 * block tagged with its uid so it can be highlighted, scrolled to, edited, or
 * removed independently. Hovering a block lights its region on the overlay;
 * clicking Edit swaps in a textarea over the block's raw Markdown fragment, and
 * saving emits a reversible text-edit. The model is the source; this is its
 * projection — so editing a fragment and re-joining stays byte-faithful.
 */
import { mdToHtml } from '../runtime/markdown.ts';
import type { BBox } from '../core/types.ts';
import type { WorkingBlock } from './corrections.ts';

export interface EditorHandle {
  readonly el: HTMLElement;
  render(blocks: WorkingBlock[]): void;
  /** Scroll a block into view and flash it (driven by the worklist stepper). */
  focusBlock(uid: string): void;
}

export interface EditorOptions {
  onEdit: (uid: string, markdown: string) => void;
  onRemove: (uid: string) => void;
  /** Hover a block ↔ highlight its page region (null on leave). */
  onHover: (box: BBox | null) => void;
}

export function createEditor(opts: EditorOptions): EditorHandle {
  const el = document.createElement('div');
  el.className = 'pe-editor';

  const render = (blocks: WorkingBlock[]): void => {
    if (!blocks.length) {
      el.innerHTML = '<div class="pe-editor-empty">Nothing was read on this page.</div>';
      return;
    }
    el.replaceChildren(...blocks.map((b) => blockEl(b, opts)));
  };

  return {
    el,
    render,
    focusBlock(uid) {
      const node = el.querySelector<HTMLElement>(`[data-uid="${cssEscape(uid)}"]`);
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.remove('pe-block-flash');
      // reflow so the animation restarts even if the class was just present
      void node.offsetWidth;
      node.classList.add('pe-block-flash');
    },
  };
}

function blockEl(block: WorkingBlock, opts: EditorOptions): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `pe-block pe-block-${block.kind}${block.added ? ' pe-block-added' : ''}`;
  wrap.dataset.uid = block.uid;

  const view = document.createElement('div');
  view.className = 'pe-block-view pe-rendered';
  view.innerHTML = mdToHtml(block.markdown);

  const tools = document.createElement('div');
  tools.className = 'pe-block-tools';
  tools.append(
    toolBtn('Edit', () => enterEdit()),
    toolBtn('Remove', () => opts.onRemove(block.uid)),
  );

  wrap.append(view, tools);

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
      wrap.replaceChildren(view, tools);
    }
  }

  return wrap;
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

/** Minimal attribute-selector escaping for our uids (`b12`, `r<uuid>`). */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
