/**
 * Resizable two-pane split. A thin divider (1px grip inside a 10px+ hit area)
 * sits after the first pane; dragging it sets the `--pe-split` custom property
 * (the first pane's flex-basis percentage), double-click resets to 50/50, and
 * ←/→ nudge ±2% when the divider has keyboard focus. The ratio persists via
 * prefs. On narrow viewports the panes stack and CSS hides the divider; the
 * custom property lives on the container, so there are no inline pane styles
 * to fight.
 */
import { readPref, writePref } from '../ui/prefs.ts';

/** Keep the split usable: never below 20% or above 80% for the first pane. */
export function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  return Math.min(0.8, Math.max(0.2, r));
}

export interface SplitHandle {
  readonly el: HTMLElement;
  destroy(): void;
}

export interface SplitOptions {
  /** prefs key the ratio persists under. */
  storageKey: string;
  /** Minimum pane width in px while dragging (default 300). */
  minPx?: number;
}

const isRatio = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function initSplit(container: HTMLElement, first: HTMLElement, opts: SplitOptions): SplitHandle {
  const minPx = opts.minPx ?? 300;

  const divider = document.createElement('div');
  divider.className = 'pe-split-divider';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', 'Resize panes — drag, arrow keys, or double-click to reset');
  divider.setAttribute('aria-valuemin', '20');
  divider.setAttribute('aria-valuemax', '80');
  divider.title = 'Drag to resize · double-click to reset';
  first.after(divider);
  container.classList.add('pe-panes-split');

  let ratio = clampRatio(readPref(opts.storageKey, isRatio) ?? 0.5);

  const apply = (r: number): void => {
    ratio = clampRatio(r);
    container.style.setProperty('--pe-split', `${(ratio * 100).toFixed(2)}%`);
    divider.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  };
  const save = (): void => writePref(opts.storageKey, ratio);
  apply(ratio);

  const ratioFromX = (clientX: number): number => {
    const r = container.getBoundingClientRect();
    if (r.width <= 0) return ratio;
    const x = Math.min(r.width - minPx, Math.max(minPx, clientX - r.left));
    return x / r.width;
  };

  let dragId: number | null = null;
  divider.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragId = e.pointerId;
    divider.setPointerCapture(dragId);
    container.classList.add('pe-panes-dragging');
  });
  divider.addEventListener('pointermove', (e) => {
    if (dragId !== e.pointerId) return;
    apply(ratioFromX(e.clientX));
  });
  const endDrag = (e: PointerEvent): void => {
    if (dragId !== e.pointerId) return;
    if (divider.hasPointerCapture(dragId)) divider.releasePointerCapture(dragId);
    dragId = null;
    container.classList.remove('pe-panes-dragging');
    save();
  };
  divider.addEventListener('pointerup', endDrag);
  divider.addEventListener('pointercancel', endDrag);

  divider.addEventListener('dblclick', () => {
    apply(0.5);
    save();
  });

  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    apply(ratio + (e.key === 'ArrowLeft' ? -0.02 : 0.02));
    save();
  });

  return {
    el: divider,
    destroy() {
      divider.remove();
      container.classList.remove('pe-panes-split', 'pe-panes-dragging');
    },
  };
}
