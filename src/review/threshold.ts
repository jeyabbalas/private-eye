/**
 * The confidence filter: a compact cluster (right side of the filter bar) with a
 * live flags chip — "3 flagged" — and a worst-first prev/next stepper. Clicking
 * the chip opens a popover holding the sensitivity slider (τ): dragging right
 * lowers the bar for what counts as uncertain, so more is flagged; the count
 * updates live and the overlay + inline highlights re-shade — without ever
 * re-blitting the raster. The slider is one persistent element re-parented into
 * each popover, so its value and wiring survive across opens.
 */
import { TAU_MAX, TAU_MIN } from './session.ts';
import { attentionSummary } from './copy.ts';
import { openPopover } from '../ui/menu.ts';

export interface ThresholdHandle {
  readonly el: HTMLElement;
  setCount(n: number): void;
  /** Enable/disable the steppers (nothing to step through when count is 0). */
  setStepEnabled(on: boolean): void;
}

export interface ThresholdOptions {
  tau: number;
  onTau: (tau: number) => void;
  onPrev: () => void;
  onNext: () => void;
}

export function createThreshold(opts: ThresholdOptions): ThresholdHandle {
  const el = document.createElement('div');
  el.className = 'pe-threshold';

  const flags = document.createElement('button');
  flags.className = 'pe-flagchip';
  flags.title = 'Adjust highlight sensitivity';
  flags.setAttribute('aria-haspopup', 'dialog');
  flags.setAttribute('aria-expanded', 'false');
  const flagsText = document.createElement('span');
  flagsText.className = 'pe-flagchip-text';
  // Announce the changing "N flagged" tally to screen readers as τ moves.
  flagsText.setAttribute('aria-live', 'polite');
  const caret = document.createElement('span');
  caret.className = 'pe-flagchip-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.textContent = '▾';
  flags.append(flagsText, caret);

  // The popover body: sensitivity slider + its hint, built once and re-parented.
  const pop = document.createElement('div');
  pop.className = 'pe-taupop';
  const sliderWrap = document.createElement('label');
  sliderWrap.className = 'pe-threshold-slider';
  const sliderLabel = document.createElement('span');
  sliderLabel.className = 'pe-threshold-label';
  sliderLabel.textContent = 'Sensitivity';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'pe-slider';
  slider.min = String(TAU_MIN);
  slider.max = String(TAU_MAX);
  slider.step = '0.05';
  slider.value = String(opts.tau);
  slider.setAttribute('aria-label', 'Highlight sensitivity');
  slider.addEventListener('input', () => opts.onTau(Number(slider.value)));
  sliderWrap.append(sliderLabel, slider);
  const hint = document.createElement('div');
  hint.className = 'pe-pop-hint';
  hint.textContent = 'Drag right to flag anything uncertain; left for only the shakiest.';
  pop.append(sliderWrap, hint);

  flags.addEventListener('click', () => {
    openPopover(flags, pop);
    slider.focus();
  });

  const steps = document.createElement('div');
  steps.className = 'pe-stepper';
  const prev = stepBtn('‹', 'Previous flagged spot', () => opts.onPrev());
  const next = stepBtn('›', 'Next flagged spot', () => opts.onNext());
  steps.append(prev, next);

  el.append(flags, steps);

  return {
    el,
    setCount(n) {
      flagsText.textContent = n > 0 ? `${n} flagged` : 'All clear';
      flags.classList.toggle('pe-flagchip-clear', n <= 0);
      flags.setAttribute('aria-label', `${attentionSummary(n)} — adjust sensitivity`);
    },
    setStepEnabled(on) {
      prev.disabled = !on;
      next.disabled = !on;
    },
  };
}

function stepBtn(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'pe-stepbtn';
  b.textContent = glyph;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}
