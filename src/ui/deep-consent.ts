/**
 * Deep Read opt-in: a one-time consent dialog before the ~1.4 GB model download.
 * Capability-aware — it tells the user, in plain language, whether their device
 * looks ready and what to expect — and reaffirms the privacy invariant (the model
 * runs in the browser; documents never leave the device). No jargon: "graphics
 * acceleration", "memory", "saved for next time" — never "WebGPU/VLM/OPFS".
 */
import { deepReadAdvisable, type Capabilities } from '../runtime/capabilities.ts';
import { showModal } from './modal.ts';
import { escapeHtml } from './progress.ts';

/** Thrown (well, used as a sentinel) when the user declines the Deep Read opt-in. */
export class DeepDeclined extends Error {
  constructor() {
    super('Deep Read was not enabled');
    this.name = 'DeepDeclined';
  }
}

function deviceLine(caps: Capabilities | undefined): { ok: boolean; text: string } {
  if (!caps) return { ok: true, text: 'Couldn’t check this device — Deep Read will preflight before it loads.' };
  const ok = deepReadAdvisable(caps);
  if (ok) return { ok: true, text: 'This device looks ready for Deep Read.' };
  return {
    ok: false,
    text: caps.webgpu
      ? 'This device may be low on memory — Deep Read could run slowly. Close other tabs before starting.'
      : 'This device has no graphics acceleration and may be tight on memory — Deep Read could be slow or run out of memory. Quick Read is the safer choice here.',
  };
}

/** Show the opt-in. Resolves true if the user chose to download + enable. */
export function confirmDeepRead(caps: Capabilities | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const cached = caps?.opfs ?? false;
    const multi = caps?.crossOriginIsolated ?? false;

    const body = document.createElement('div');
    body.className = 'pe-deep-consent';
    const dev = deviceLine(caps);
    body.innerHTML = `
      <p>Deep Read brings in a larger AI model for tricky tables, dense forms, and faint or
      handwritten text. Quick Read stays available — it’s faster for everyday scans, and Deep
      Read double-checks its numbers against it.</p>
      <ul class="pe-consent-list">
        <li><strong>One-time download of about 1.4&nbsp;GB.</strong> ${
          cached ? 'It’s then saved on your device and loads quickly next time.' : 'It loads fresh for this session.'
        }</li>
        <li><strong>Runs best</strong> on a recent desktop browser with a few gigabytes of free memory${
          multi ? '.' : ' (multi-core speed-up is off in this browser).'
        }</li>
        <li><strong>Still completely private.</strong> The model runs inside your browser; your
        documents never leave this device.</li>
      </ul>
      <div class="pe-consent-device ${dev.ok ? 'pe-consent-ok' : 'pe-consent-warn'}">
        <span aria-hidden="true">${dev.ok ? '✓' : '⚠'}</span> ${escapeHtml(dev.text)}
      </div>
      <p class="pe-consent-foot">You can keep using Quick Read while it downloads.</p>`;

    showModal({
      title: 'Turn on Deep Read?',
      body,
      dismissable: false,
      actions: [
        { label: 'Download & turn on', primary: true, onClick: () => resolve(true) },
        { label: 'Not now', onClick: () => resolve(false) },
      ],
    });
  });
}
