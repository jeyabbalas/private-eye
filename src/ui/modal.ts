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

let modalSeq = 0;

export function showModal(opts: ModalOptions): ModalHandle {
  // The control to return focus to once the modal closes (focus management).
  const previouslyFocused = document.activeElement as HTMLElement | null;

  const backdrop = document.createElement('div');
  backdrop.className = 'pe-modal-backdrop';

  const modal = document.createElement('div');
  modal.className = 'pe-modal';
  // Dialog semantics live on the modal itself (the backdrop is just the dim
  // layer); tabIndex -1 lets us park focus here when there's nothing else.
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.tabIndex = -1;
  backdrop.appendChild(modal);

  const h = document.createElement('h3');
  const titleId = `pe-modal-title-${modalSeq++}`;
  h.id = titleId;
  h.textContent = opts.title;
  modal.setAttribute('aria-labelledby', titleId);
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
  const focusables = (): HTMLElement[] =>
    Array.from(
      modal.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
      ),
    );
  function onKey(e: KeyboardEvent): void {
    if (dismissable && e.key === 'Escape') {
      handle.close();
      return;
    }
    if (e.key !== 'Tab') return;
    // Trap Tab within the modal (wrapping at both ends) so keyboard focus can't
    // wander to the inert page behind it.
    const f = focusables();
    if (!f.length) {
      e.preventDefault();
      modal.focus();
      return;
    }
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const active = document.activeElement;
    if (!modal.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
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
      previouslyFocused?.focus?.();
    },
  };

  document.body.appendChild(backdrop);
  // Move focus into the dialog (primary action first) so keyboard / screen-reader
  // users land inside it rather than on the now-inert page.
  ((modal.querySelector('.pe-btn-primary') as HTMLElement | null) ?? focusables()[0] ?? modal).focus();
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
