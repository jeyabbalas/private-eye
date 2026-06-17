import './app.css';
import { buildHeader, logoUrl } from './header.ts';
import { detectCapabilities } from '../runtime/capabilities.ts';
import { isDebug, log } from '../runtime/logger.ts';
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

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  setFavicon(logoUrl);

  window.addEventListener('error', (e) => log.error(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => log.error(e.reason));

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

  workspace = new Workspace(quick);
  app.replaceChildren(buildHeader(), workspace.el);

  // Eagerly warm Quick Read as soon as the page loads (per product intent).
  quick.warm();

  // Open storage, restore any prior session, and resume interrupted processing.
  await workspace.init().catch((e) => {
    log.error(e);
    showErrorModal({
      kind: 'Unknown',
      userMessage: "Couldn't open local storage, so your work can't be saved this session.",
      technical: e instanceof Error ? (e.stack ?? e.message) : String(e),
    });
  });
}

void boot();
