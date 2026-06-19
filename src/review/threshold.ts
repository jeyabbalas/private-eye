/**
 * The confidence filter: a thin bar (sits above both panes) with the live "N spots
 * flagged" count, a sensitivity slider (τ), and a worst-first prev/next stepper.
 * Dragging the slider right lowers the bar for what counts as uncertain, so more is
 * flagged; the count updates live and the overlay + inline highlights re-shade —
 * without ever re-blitting the raster.
 */
import { TAU_MAX, TAU_MIN } from './session.ts';
import { attentionSummary } from './copy.ts';

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

  const count = document.createElement('div');
  count.className = 'pe-threshold-count';
  // Announce the changing "N spots flagged" tally to screen readers as τ moves.
  count.setAttribute('aria-live', 'polite');

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
  slider.title = 'Drag right to flag anything uncertain; left for only the shakiest';
  slider.setAttribute('aria-label', 'Highlight sensitivity');
  slider.addEventListener('input', () => opts.onTau(Number(slider.value)));
  sliderWrap.append(sliderLabel, slider);

  const steps = document.createElement('div');
  steps.className = 'pe-stepper';
  const prev = stepBtn('‹', 'Previous flagged spot', () => opts.onPrev());
  const next = stepBtn('›', 'Next flagged spot', () => opts.onNext());
  steps.append(prev, next);

  el.append(count, sliderWrap, steps);

  return {
    el,
    setCount(n) {
      count.textContent = attentionSummary(n);
      count.classList.toggle('pe-threshold-clear', n <= 0);
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
