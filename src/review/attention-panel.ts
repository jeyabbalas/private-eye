/**
 * The attention panel: the prioritized worklist rendered as context cards. Order
 * comes straight from buildAttention (conflicts → hard-gate numbers → worst-first
 * blocks/lines → gaps → advisory words). Each card explains the concern in plain
 * language and offers two actions: Show (pan the overlay + scroll the linked
 * block) and Dismiss (drop it from the list; recorded so it stays gone).
 */
import type { AttentionItem } from './attention.ts';
import { CATEGORY_LABEL } from './attention.ts';
import { ALL_CLEAR } from './copy.ts';
import { escapeHtml } from '../ui/progress.ts';

export interface AttentionPanelHandle {
  readonly el: HTMLElement;
  render(items: AttentionItem[]): void;
}

export interface AttentionPanelOptions {
  onShow: (item: AttentionItem) => void;
  onDismiss: (item: AttentionItem) => void;
  /** Override a cross-model conflict to the AI reading (the safe scan reading is
   *  already applied under the 'replace' anchor policy, so accepting it needs no action). */
  onUseAiReading?: (item: AttentionItem) => void;
}

export function createAttentionPanel(opts: AttentionPanelOptions): AttentionPanelHandle {
  const el = document.createElement('div');
  el.className = 'pe-attention';

  const list = document.createElement('div');
  list.className = 'pe-attention-list';
  el.appendChild(list);

  const render = (items: AttentionItem[]): void => {
    if (!items.length) {
      list.innerHTML = `<div class="pe-attention-clear">${escapeHtml(ALL_CLEAR)}</div>`;
      return;
    }
    list.replaceChildren(...items.map((item) => card(item, opts)));
  };

  render([]);
  return { el, render };
}

function card(item: AttentionItem, opts: AttentionPanelOptions): HTMLElement {
  const c = document.createElement('div');
  c.className = `pe-att-card pe-att-${item.category}${item.graded ? '' : ' pe-att-categorical'}`;

  const head = document.createElement('div');
  head.className = 'pe-att-head';
  const label = document.createElement('span');
  label.className = 'pe-att-label';
  label.textContent = CATEGORY_LABEL[item.category];
  head.appendChild(label);

  const detail = document.createElement('div');
  detail.className = 'pe-att-detail';
  detail.textContent = item.detail;

  const actions = document.createElement('div');
  actions.className = 'pe-att-actions';
  // The output already carries the safe scan reading (anchor 'replace'); for a
  // cross-model conflict offer a one-click override to the AI's reading — the
  // "override" half of accept/override (accepting the scan needs no action).
  if (opts.onUseAiReading && item.conflict?.ocrReading) {
    actions.append(miniBtn(`Use the AI’s “${truncate(item.conflict.vlmReading)}”`, () => opts.onUseAiReading!(item), true));
  }
  actions.append(
    miniBtn('Show', () => opts.onShow(item), false, `Show — ${CATEGORY_LABEL[item.category]}`),
    miniBtn('Dismiss', () => opts.onDismiss(item), false, `Dismiss — ${CATEGORY_LABEL[item.category]}`),
  );

  c.append(head, detail, actions);
  // Clicking the card body (not its buttons) also focuses the region.
  c.addEventListener('click', (e) => {
    if (!(e.target instanceof HTMLButtonElement)) opts.onShow(item);
  });
  return c;
}

function miniBtn(label: string, onClick: () => void, primary = false, ariaLabel?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'pe-att-btn' + (primary ? ' pe-att-btn-primary' : '');
  b.textContent = label;
  if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function truncate(s: string, n = 16): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
