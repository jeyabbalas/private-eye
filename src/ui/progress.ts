/**
 * Loading / progress primitives. The guiding rule: the app must always show
 * motion so it never feels crashed. Determinate progress bars where bytes or
 * counts are known (model downloads, page batches); an indeterminate magnifier
 * sweep + elapsed timer where they aren't (a single page's stages).
 */

const MAGNIFIER_SVG = `
<svg class="pe-magnifier" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
  <circle cx="10.5" cy="10.5" r="6.5"></circle>
  <line x1="15.5" y1="15.5" x2="21" y2="21" stroke-linecap="round"></line>
</svg>`;

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

export interface ProgressHandle {
  readonly el: HTMLElement;
  setLabel(text: string): void;
  /** Determinate fill. If total<=0, switches to indeterminate. */
  setDeterminate(loaded: number, total: number): void;
  setIndeterminate(): void;
  /** Determinate fill plus a "120 / 1430 MB · ~12s left" sublabel. */
  setDownload(loaded: number, total: number): void;
  setSub(text: string): void;
  destroy(): void;
}

export function createProgressBlock(initialLabel = ''): ProgressHandle {
  const el = document.createElement('div');
  el.className = 'pe-boot';
  el.innerHTML = `
    <div style="color:var(--ink)">${MAGNIFIER_SVG}</div>
    <div class="pe-status-line" data-role="label">${escapeHtml(initialLabel)}</div>
    <div class="pe-progress indeterminate" data-role="bar"><div class="pe-progress-fill"></div></div>
    <div class="pe-status-line" data-role="sub" style="font-size:12px;color:var(--faint)"></div>`;

  const labelEl = el.querySelector<HTMLElement>('[data-role="label"]')!;
  const barEl = el.querySelector<HTMLElement>('[data-role="bar"]')!;
  const fillEl = barEl.querySelector<HTMLElement>('.pe-progress-fill')!;
  const subEl = el.querySelector<HTMLElement>('[data-role="sub"]')!;

  const startedAt = performance.now();
  let lastLoaded = 0;
  let lastTime = startedAt;
  let rate = 0; // bytes/ms, smoothed

  return {
    el,
    setLabel(text) {
      labelEl.textContent = text;
    },
    setSub(text) {
      subEl.textContent = text;
    },
    setIndeterminate() {
      barEl.classList.add('indeterminate');
      fillEl.style.width = '';
    },
    setDeterminate(loaded, total) {
      if (total <= 0) {
        this.setIndeterminate();
        return;
      }
      barEl.classList.remove('indeterminate');
      fillEl.style.width = `${Math.min(100, (loaded / total) * 100).toFixed(1)}%`;
    },
    setDownload(loaded, total) {
      this.setDeterminate(loaded, total);
      const now = performance.now();
      const dt = now - lastTime;
      if (dt > 250) {
        const inst = (loaded - lastLoaded) / dt;
        rate = rate === 0 ? inst : rate * 0.7 + inst * 0.3;
        lastLoaded = loaded;
        lastTime = now;
      }
      let sub = total > 0 ? `${fmtBytes(loaded)} / ${fmtBytes(total)}` : fmtBytes(loaded);
      if (rate > 0 && total > loaded) {
        const etaS = (total - loaded) / rate / 1000;
        sub += ` · ~${etaS < 60 ? `${Math.ceil(etaS)}s` : `${Math.ceil(etaS / 60)}m`} left`;
      }
      subEl.textContent = sub;
    },
    destroy() {
      el.remove();
    },
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
