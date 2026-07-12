/**
 * Keyboard routing for the review surface, as a pure decision function so the
 * bindings are testable in plain Node. One `keydown` listener on `.pe-review`
 * calls `reviewKeyAction` and dispatches the returned action to the scan view /
 * session / page-nav callback.
 *
 * Guard rails, in priority order:
 *  - typing always wins: any editable target returns null (so a textarea keeps
 *    its characters and native Ctrl/⌘+Z undo);
 *  - Escape and Tab are NEVER claimed — draw-cancel, popover close, and focus
 *    navigation stay free;
 *  - Ctrl/⌘+Z maps to the correction undo anywhere in the surface;
 *  - other modifier chords are left to the browser;
 *  - mid region-draw (rubber-band live or OCR busy) pan/zoom/page keys go
 *    inert;
 *  - `[` / `]` (page prev/next) work anywhere in the surface; pan/zoom keys
 *    only when the scan viewport itself has focus.
 */

export type ReviewKeyAction =
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'pan-page'; dir: 1 | -1 }
  | { kind: 'pan-edge'; edge: 'top' | 'bottom' }
  | { kind: 'zoom'; factor: number }
  | { kind: 'fit' }
  | { kind: 'actual' }
  | { kind: 'page'; dir: 1 | -1 }
  | { kind: 'undo' };

export interface ReviewKeyMods {
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
}

export interface ReviewKeyContext {
  /** A typing surface (input/textarea/contenteditable) has focus. */
  inEditable: boolean;
  /** A region draw is mid-drag or its OCR is running. */
  drawing: boolean;
  /** The scan viewport element itself has keyboard focus. */
  scanFocused: boolean;
}

/** Arrow-key pan step in CSS px (Shift multiplies ×3). */
export const PAN_STEP = 60;

/** Keyboard zoom step — matches the toolbar's − / + buttons. */
export const KEY_ZOOM = 1.25;

export function reviewKeyAction(
  key: string,
  mods: ReviewKeyMods,
  ctx: ReviewKeyContext,
): ReviewKeyAction | null {
  if (ctx.inEditable) return null;
  if (key === 'Escape' || key === 'Tab') return null;
  const primary = mods.ctrl || mods.meta;
  if (primary && !mods.alt && (key === 'z' || key === 'Z')) return { kind: 'undo' };
  if (primary || mods.alt) return null;
  if (ctx.drawing) return null;
  if (key === '[') return { kind: 'page', dir: -1 };
  if (key === ']') return { kind: 'page', dir: 1 };
  if (!ctx.scanFocused) return null;
  const step = mods.shift ? PAN_STEP * 3 : PAN_STEP;
  switch (key) {
    case 'ArrowLeft':
      return { kind: 'pan', dx: -step, dy: 0 };
    case 'ArrowRight':
      return { kind: 'pan', dx: step, dy: 0 };
    case 'ArrowUp':
      return { kind: 'pan', dx: 0, dy: -step };
    case 'ArrowDown':
      return { kind: 'pan', dx: 0, dy: step };
    case 'PageUp':
      return { kind: 'pan-page', dir: -1 };
    case 'PageDown':
      return { kind: 'pan-page', dir: 1 };
    case 'Home':
      return { kind: 'pan-edge', edge: 'top' };
    case 'End':
      return { kind: 'pan-edge', edge: 'bottom' };
    case '+':
    case '=':
      return { kind: 'zoom', factor: KEY_ZOOM };
    case '-':
    case '_':
      return { kind: 'zoom', factor: 1 / KEY_ZOOM };
    case '0':
    case 'f':
      return { kind: 'fit' };
    case '1':
      return { kind: 'actual' };
    default:
      return null;
  }
}

/** True when key events on `t` are text entry (so shortcuts must stand down).
 *  DOM-touching, so kept out of reviewKeyAction (which stays Node-testable). */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) {
    return true;
  }
  return t.isContentEditable;
}
