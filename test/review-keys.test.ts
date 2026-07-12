/**
 * Keyboard routing for the review surface (keys.ts). Pins the guard rails —
 * typing always wins, Escape/Tab are never claimed, modifier chords stay with
 * the browser, drawing suppresses movement — and every binding in the map.
 */
import { describe, it, expect } from 'vitest';
import { KEY_ZOOM, PAN_STEP, reviewKeyAction, type ReviewKeyContext, type ReviewKeyMods } from '../src/review/keys.ts';

const mods = (m: Partial<ReviewKeyMods> = {}): ReviewKeyMods => ({
  shift: false,
  ctrl: false,
  meta: false,
  alt: false,
  ...m,
});

const ctx = (c: Partial<ReviewKeyContext> = {}): ReviewKeyContext => ({
  inEditable: false,
  drawing: false,
  scanFocused: true,
  ...c,
});

describe('reviewKeyAction guards', () => {
  it('returns null for everything while typing (native editing wins)', () => {
    const editable = ctx({ inEditable: true });
    for (const key of ['ArrowDown', 'PageDown', 'Home', '+', '-', '0', '1', 'f', '[', ']']) {
      expect(reviewKeyAction(key, mods(), editable)).toBeNull();
    }
    // Ctrl/⌘+Z in a textarea stays the native text undo
    expect(reviewKeyAction('z', mods({ ctrl: true }), editable)).toBeNull();
    expect(reviewKeyAction('z', mods({ meta: true }), editable)).toBeNull();
  });

  it('never claims Escape or Tab in any context', () => {
    for (const c of [ctx(), ctx({ drawing: true }), ctx({ scanFocused: false }), ctx({ inEditable: true })]) {
      expect(reviewKeyAction('Escape', mods(), c)).toBeNull();
      expect(reviewKeyAction('Tab', mods(), c)).toBeNull();
      expect(reviewKeyAction('Tab', mods({ shift: true }), c)).toBeNull();
    }
  });

  it('leaves modifier chords (other than undo) to the browser', () => {
    expect(reviewKeyAction('ArrowDown', mods({ ctrl: true }), ctx())).toBeNull();
    expect(reviewKeyAction('+', mods({ meta: true }), ctx())).toBeNull(); // browser zoom
    expect(reviewKeyAction('[', mods({ meta: true }), ctx())).toBeNull(); // history nav
    expect(reviewKeyAction('ArrowLeft', mods({ alt: true }), ctx())).toBeNull();
    expect(reviewKeyAction('z', mods({ ctrl: true, alt: true }), ctx())).toBeNull();
  });

  it('suppresses pan/zoom/page keys mid-draw, but undo still works', () => {
    const drawing = ctx({ drawing: true });
    for (const key of ['ArrowDown', 'PageUp', 'Home', 'End', '+', '-', '0', '1', '[', ']']) {
      expect(reviewKeyAction(key, mods(), drawing)).toBeNull();
    }
    expect(reviewKeyAction('z', mods({ meta: true }), drawing)).toEqual({ kind: 'undo' });
  });

  it('requires scan focus for pan/zoom keys, but not for page nav or undo', () => {
    const unfocused = ctx({ scanFocused: false });
    for (const key of ['ArrowDown', 'PageDown', 'Home', 'End', '+', '-', '0', 'f', '1']) {
      expect(reviewKeyAction(key, mods(), unfocused)).toBeNull();
    }
    expect(reviewKeyAction('[', mods(), unfocused)).toEqual({ kind: 'page', dir: -1 });
    expect(reviewKeyAction(']', mods(), unfocused)).toEqual({ kind: 'page', dir: 1 });
    expect(reviewKeyAction('z', mods({ ctrl: true }), unfocused)).toEqual({ kind: 'undo' });
  });

  it('ignores unmapped keys', () => {
    expect(reviewKeyAction('a', mods(), ctx())).toBeNull();
    expect(reviewKeyAction('Enter', mods(), ctx())).toBeNull();
    expect(reviewKeyAction(' ', mods(), ctx())).toBeNull();
  });
});

describe('reviewKeyAction bindings', () => {
  it('arrows pan by the step, Shift ×3', () => {
    expect(reviewKeyAction('ArrowLeft', mods(), ctx())).toEqual({ kind: 'pan', dx: -PAN_STEP, dy: 0 });
    expect(reviewKeyAction('ArrowRight', mods(), ctx())).toEqual({ kind: 'pan', dx: PAN_STEP, dy: 0 });
    expect(reviewKeyAction('ArrowUp', mods(), ctx())).toEqual({ kind: 'pan', dx: 0, dy: -PAN_STEP });
    expect(reviewKeyAction('ArrowDown', mods(), ctx())).toEqual({ kind: 'pan', dx: 0, dy: PAN_STEP });
    expect(reviewKeyAction('ArrowDown', mods({ shift: true }), ctx())).toEqual({ kind: 'pan', dx: 0, dy: PAN_STEP * 3 });
  });

  it('PageUp/PageDown step by viewport, Home/End jump to the edges', () => {
    expect(reviewKeyAction('PageUp', mods(), ctx())).toEqual({ kind: 'pan-page', dir: -1 });
    expect(reviewKeyAction('PageDown', mods(), ctx())).toEqual({ kind: 'pan-page', dir: 1 });
    expect(reviewKeyAction('Home', mods(), ctx())).toEqual({ kind: 'pan-edge', edge: 'top' });
    expect(reviewKeyAction('End', mods(), ctx())).toEqual({ kind: 'pan-edge', edge: 'bottom' });
  });

  it('plus/minus zoom (with and without shift variants), 0/f fit, 1 actual', () => {
    expect(reviewKeyAction('+', mods({ shift: true }), ctx())).toEqual({ kind: 'zoom', factor: KEY_ZOOM });
    expect(reviewKeyAction('=', mods(), ctx())).toEqual({ kind: 'zoom', factor: KEY_ZOOM });
    expect(reviewKeyAction('-', mods(), ctx())).toEqual({ kind: 'zoom', factor: 1 / KEY_ZOOM });
    expect(reviewKeyAction('_', mods({ shift: true }), ctx())).toEqual({ kind: 'zoom', factor: 1 / KEY_ZOOM });
    expect(reviewKeyAction('0', mods(), ctx())).toEqual({ kind: 'fit' });
    expect(reviewKeyAction('f', mods(), ctx())).toEqual({ kind: 'fit' });
    expect(reviewKeyAction('1', mods(), ctx())).toEqual({ kind: 'actual' });
  });

  it('[ and ] page across read pages', () => {
    expect(reviewKeyAction('[', mods(), ctx())).toEqual({ kind: 'page', dir: -1 });
    expect(reviewKeyAction(']', mods(), ctx())).toEqual({ kind: 'page', dir: 1 });
  });

  it('Ctrl/⌘+Z (either case) is the correction undo', () => {
    expect(reviewKeyAction('z', mods({ ctrl: true }), ctx())).toEqual({ kind: 'undo' });
    expect(reviewKeyAction('z', mods({ meta: true }), ctx())).toEqual({ kind: 'undo' });
    expect(reviewKeyAction('Z', mods({ meta: true, shift: true }), ctx())).toEqual({ kind: 'undo' });
    expect(reviewKeyAction('z', mods(), ctx())).toBeNull(); // bare z does nothing
  });
});
