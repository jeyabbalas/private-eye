/**
 * Modal primitives. Critical errors surface here with a SIMPLE human sentence
 * plus a copy-pasteable TECHNICAL block (for bug reports) — never raw jargon in
 * the main message. Also a generic modal used for confirmations (e.g. the Deep
 * Read download/device warning in a later phase).
 */
import type { AppError } from '../runtime/errors.ts';
import { escapeHtml } from './progress.ts';

export interface ModalAction {
  label: string;
  primary?: boolean;
  /** Return false to keep the modal open. */
  onClick?: () => void | boolean;
}

export interface ModalOptions {
  title: string;
  /** Plain text or an element to mount in the body. */
  body: string | HTMLElement;
  /** Collapsible technical block (monospace, with a Copy button). */
  technical?: string;
  actions?: ModalAction[];
  /** Allow closing via backdrop click / Escape (default true). */
  dismissable?: boolean;
}

export interface ModalHandle {
  close(): void;
}

export function showModal(opts: ModalOptions): ModalHandle {
  const backdrop = document.createElement('div');
  backdrop.className = 'pe-modal-backdrop';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');

  const modal = document.createElement('div');
  modal.className = 'pe-modal';
  backdrop.appendChild(modal);

  const h = document.createElement('h3');
  h.textContent = opts.title;
  modal.appendChild(h);

  if (typeof opts.body === 'string') {
    const p = document.createElement('p');
    p.textContent = opts.body;
    modal.appendChild(p);
  } else {
    modal.appendChild(opts.body);
  }

  if (opts.technical) {
    const details = document.createElement('details');
    details.innerHTML = `<summary>Technical details</summary><pre>${escapeHtml(opts.technical)}</pre>`;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'pe-btn';
    copyBtn.style.marginTop = '8px';
    copyBtn.textContent = 'Copy details';
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard?.writeText(opts.technical!).then(
        () => {
          copyBtn.textContent = 'Copied';
          setTimeout(() => (copyBtn.textContent = 'Copy details'), 1500);
        },
        () => (copyBtn.textContent = 'Press ⌘/Ctrl+C'),
      );
    });
    details.appendChild(copyBtn);
    modal.appendChild(details);
  }

  const actionsEl = document.createElement('div');
  actionsEl.className = 'pe-modal-actions';
  const actions = opts.actions ?? [{ label: 'Close', primary: true }];
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = 'pe-btn' + (action.primary ? ' pe-btn-primary' : '');
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      const keepOpen = action.onClick?.() === false;
      if (!keepOpen) handle.close();
    });
    actionsEl.appendChild(btn);
  }
  modal.appendChild(actionsEl);

  const dismissable = opts.dismissable !== false;
  function onKey(e: KeyboardEvent): void {
    if (dismissable && e.key === 'Escape') handle.close();
  }
  if (dismissable) {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) handle.close();
    });
  }
  document.addEventListener('keydown', onKey);

  const handle: ModalHandle = {
    close() {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    },
  };

  document.body.appendChild(backdrop);
  return handle;
}

export function showErrorModal(err: AppError): ModalHandle {
  return showModal({
    title: 'Something needs your attention',
    body: err.userMessage,
    technical: err.technical,
    actions: [{ label: 'Close', primary: true }],
  });
}
