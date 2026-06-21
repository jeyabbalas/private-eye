import './app.css';
import { buildHeader, logoUrl } from './header.ts';
import { detectCapabilities, unsupportedReason } from '../runtime/capabilities.ts';
import { prepareModelCache } from '../runtime/model-cache.ts';
import { isDebug, log } from '../runtime/logger.ts';
import { reportError } from '../runtime/errors.ts';
import { QuickClient } from '../workers/client.ts';
import { Workspace } from './workspace.ts';
import { showErrorModal } from './modal.ts';

function setFavicon(href: string): void {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = href;
}

/** Save-Data / very-slow connections: defer the eager ~275 MB Quick Read warm-up
 *  (it then loads on the first upload instead). The Network Information API is
 *  Chromium-only; treat its absence as "not metered" so the primary audience keeps
 *  instant readiness. */
function meteredConnection(): boolean {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  return !!c && (c.saveData === true || /2g$/.test(c.effectiveType ?? ''));
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  setFavicon(logoUrl);

  window.addEventListener('error', (e) => log.error(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => log.error(e.reason));

  // Hard-requirement gate: if the browser can't run the core pipeline, say so in
  // plain language rather than failing later with a blank page / console-only error.
  const unsupported = unsupportedReason();
  if (unsupported) {
    app.replaceChildren(buildHeader());
    showErrorModal({
      kind: 'Capability',
      userMessage:
        'Private Eye needs a more capable browser. Please use an up-to-date Chrome, Edge, Firefox, or Safari over HTTPS.',
      technical: `unsupported environment: ${unsupported}\nuserAgent: ${navigator.userAgent}`,
    });
    return;
  }

  try {
    // Best-effort: request durable storage and drop any stale-version model cache before
    // the eager Quick Read warm-up below begins populating CacheStorage with HF weights.
    void prepareModelCache();

    const caps = await detectCapabilities().catch((e) => {
      log.error(e);
      return undefined;
    });
    log.debug('capabilities', caps, '· coi', self.crossOriginIsolated, '· build', __APP_VERSION__);

    const onnxEp = caps?.webgpu ? 'webgpu' : 'wasm';

    let workspace: Workspace | undefined;
    const quick = new QuickClient({
      debug: isDebug(),
      onnxEp,
      handlers: {
        onReady: (note) => {
          workspace?.setReady();
          log.debug('Quick Read ready', note);
        },
        onError: (err) => showErrorModal(err),
      },
    });

    // Skip the eager ~275 MB warm-up on metered / Data-Saver connections; the first
    // upload's run still loads the models on demand (the worker calls ensureE).
    const warmDeferred = meteredConnection();
    workspace = new Workspace(quick, caps, warmDeferred);
    app.replaceChildren(buildHeader(), workspace.el);

    if (warmDeferred) log.debug('Quick Read warm-up deferred (metered connection)');
    else quick.warm();

    // Open storage, restore any prior session, and resume interrupted processing.
    await workspace.init().catch((e) => {
      log.error(e);
      showErrorModal({
        kind: 'Unknown',
        userMessage: "Couldn't open local storage, so your work can't be saved this session.",
        technical: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
    });
  } catch (e) {
    // Setting up the worker/workspace could otherwise fail to a blank page and a
    // console-only error; surface it so the user (and a bug report) can see it.
    log.error(e);
    showErrorModal(reportError(e, { context: 'boot' }));
  }
}

void boot();
