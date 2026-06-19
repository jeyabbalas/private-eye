/**
 * The attention control bar: a sensitivity slider (τ) plus the live "N spots
 * flagged" count and a worst-first "Review next" stepper. Dragging right lowers
 * the bar for what counts as uncertain, so more is flagged; the count updates
 * live and the overlay re-shades — without ever re-blitting the raster.
 */
import { TAU_MAX, TAU_MIN } from './session.ts';
import { attentionSummary, NEXT_LEAD } from './copy.ts';

export interface ThresholdHandle {
  readonly el: HTMLElement;
  setCount(n: number): void;
  /** Enable/disable the stepper (nothing to step through when count is 0). */
  setStepEnabled(on: boolean): void;
}

export interface ThresholdOptions {
  tau: number;
  onTau: (tau: number) => void;
  onNext: () => void;
}

export function createThreshold(opts: ThresholdOptions): ThresholdHandle {
  const el = document.createElement('div');
  el.className = 'pe-threshold';

  const count = document.createElement('div');
  count.className = 'pe-threshold-count';
  // Announce the changing "N spots flagged" tally to screen readers as the slider moves.
  count.setAttribute('aria-live', 'polite');

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'pe-slider';
  slider.min = String(TAU_MIN);
  slider.max = String(TAU_MAX);
  slider.step = '0.05';
  slider.value = String(opts.tau);
  slider.setAttribute('aria-label', 'Highlight sensitivity');
  slider.addEventListener('input', () => opts.onTau(Number(slider.value)));

  const scale = document.createElement('div');
  scale.className = 'pe-threshold-scale';
  scale.innerHTML = '<span>Only the shakiest</span><span>Anything uncertain</span>';

  const sliderWrap = document.createElement('div');
  sliderWrap.className = 'pe-threshold-slider';
  sliderWrap.append(slider, scale);

  const next = document.createElement('button');
  next.className = 'pe-btn';
  next.textContent = NEXT_LEAD;
  next.addEventListener('click', () => opts.onNext());

  const row = document.createElement('div');
  row.className = 'pe-threshold-row';
  row.append(count, next);

  el.append(row, sliderWrap);

  return {
    el,
    setCount(n) {
      count.textContent = attentionSummary(n);
      count.classList.toggle('pe-threshold-clear', n <= 0);
    },
    setStepEnabled(on) {
      next.disabled = !on;
    },
  };
}
