/**
 * The workspace: a multi-file document manager. Users add images and PDFs; pages
 * are persisted, processed one at a time by the queue (models stay resident), and
 * survive reloads. Processed pages can be viewed and the whole batch downloaded
 * as Markdown.
 *
 * This is Phase 2's surface — the viewer is read-only Markdown for now; the full
 * review/correction tooling (overlay, threshold, editing) arrives in Phase 3.
 */
import { QuickClient } from '../workers/client.ts';
import { DeepClient } from '../workers/deep-client.ts';
import { ProcessingQueue, type QueueEvent } from '../orchestrate/queue.ts';
import { ingestFiles } from '../orchestrate/ingest.ts';
import {
  allDocuments,
  deleteDocumentCascade,
  pagesByDocument,
  pagesByStatus,
  putPage,
} from '../orchestrate/db.ts';
import {
  documentMarkdown,
  exportAllZip,
  markdownName,
  triggerDownload,
} from '../orchestrate/export.ts';
import {
  PROCESSED,
  TERMINAL,
  type DocumentRecord,
  type PageId,
  type PageRecord,
  type ReadMode,
} from '../orchestrate/types.ts';
import { ReviewSurface } from '../review/surface.ts';
import { showErrorModal, showModal } from './modal.ts';
import { confirmDeepRead, DeepDeclined } from './deep-consent.ts';
import { escapeHtml, fmtBytes } from './progress.ts';
import { CASE_CLOSED, deepPhaseMessage, SPECIALIST, stageMessage, WARMING } from './copy.ts';
import type { DeepPhaseKind, StageKey } from '../workers/protocol.ts';
import type { Capabilities } from '../runtime/capabilities.ts';
import { isDebug } from '../runtime/logger.ts';
import { reportError } from '../runtime/errors.ts';

const ACCEPT = 'image/*,application/pdf,.pdf';

export class Workspace {
  readonly el: HTMLElement;
  private readonly queue: ProcessingQueue;

  private docs: DocumentRecord[] = [];
  private readonly pagesByDoc = new Map<string, PageRecord[]>();
  private readonly pageMap = new Map<PageId, PageRecord>();
  private readonly chipEls = new Map<PageId, HTMLButtonElement>();
  private readonly rollupEls = new Map<string, HTMLElement>();

  private selectedPageId: PageId | null = null;
  private surface: ReviewSurface | null = null;
  private ready = false;

  // status bar
  private statusMain: HTMLElement | null = null;
  private statusSub: HTMLElement | null = null;
  private statusBar: HTMLElement | null = null;
  private statusFill: HTMLElement | null = null;
  private downloadAllBtn: HTMLButtonElement | null = null;
  private stopBtn: HTMLButtonElement | null = null;

  // Deep Read (opt-in)
  private mode: ReadMode = 'quick';
  private deep: DeepClient | null = null;
  private deepState: 'off' | 'loading' | 'ready' = 'off';
  /** Memoized consent + load, so the toggle and the queue share one gate. */
  private deepReadyPromise: Promise<DeepClient> | null = null;
  private deepLoaded = 0;
  private deepTotal = 0;
  private readonly modeEls = new Map<ReadMode, HTMLButtonElement>();
  private unloadBtn: HTMLButtonElement | null = null;

  // busy-state animation
  private currentPageId: PageId | null = null;
  private currentMode: ReadMode = 'quick';
  private currentStage: StageKey = 'loading';
  private currentDeepPhase: DeepPhaseKind = 'preparing';
  private currentDeepIndex?: number;
  private currentDeepTotal?: number;
  private deepStartedAt = 0;
  private deepTicker: number | null = null;
  private rotateTimer: number | null = null;
  private tick = 0;
  private errorShownThisBatch = false;

  constructor(
    private readonly quick: QuickClient,
    private readonly caps?: Capabilities,
  ) {
    this.queue = new ProcessingQueue(quick);
    this.queue.setDeepProvider(() => this.ensureDeepReady());
    this.queue.subscribe((e) => this.onQueueEvent(e));

    this.el = document.createElement('main');
    this.el.className = 'pe-main';
    this.installDropTarget(this.el);
  }

  /** Open storage, recover any interrupted work, render, and resume processing. */
  async init(): Promise<void> {
    await this.restoreInterrupted();
    this.docs = await allDocuments();
    this.pagesByDoc.clear();
    this.pageMap.clear();
    const toQueue: PageId[] = [];
    for (const doc of this.docs) {
      const pages = await pagesByDocument(doc.id);
      this.pagesByDoc.set(doc.id, pages);
      for (const p of pages) {
        this.pageMap.set(p.id, p);
        if (p.status === 'queued') toQueue.push(p.id);
      }
    }
    this.render();
    if (toQueue.length) {
      this.errorShownThisBatch = false;
      this.queue.enqueue(toQueue);
    }
  }

  /** Called when Quick Read finishes warming up. */
  setReady(): void {
    this.ready = true;
    const hint = this.el.querySelector<HTMLElement>('.pe-hint');
    if (hint) hint.textContent = 'Quick Read is ready — add images or PDFs to begin.';
  }

  // ---------- recovery ----------

  private async restoreInterrupted(): Promise<void> {
    const interrupted = [...(await pagesByStatus('processing')), ...(await pagesByStatus('rasterizing'))];
    await Promise.all(
      interrupted.map((p) => putPage({ ...p, status: 'queued', updatedAt: Date.now() })),
    );
  }

  // ---------- ingestion ----------

  private installDropTarget(target: HTMLElement): void {
    target.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        target.classList.add('pe-drag');
      }
    });
    target.addEventListener('dragleave', (e) => {
      if (e.target === target) target.classList.remove('pe-drag');
    });
    target.addEventListener('drop', (e) => {
      e.preventDefault();
      target.classList.remove('pe-drag');
      const files = e.dataTransfer?.files;
      if (files && files.length) void this.addFiles([...files]);
    });
  }

  private pickFiles(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;
    input.multiple = true;
    input.addEventListener('change', () => {
      if (input.files && input.files.length) void this.addFiles([...input.files]);
    });
    input.click();
  }

  private async addFiles(files: File[]): Promise<void> {
    let summary;
    try {
      summary = await ingestFiles(files);
    } catch (e) {
      showErrorModal({
        kind: 'Unknown',
        userMessage: "Couldn't add those files.",
        technical: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      return;
    }

    const newPageIds: PageId[] = [];
    for (const { doc, pages } of summary.added) {
      this.docs.push(doc);
      this.pagesByDoc.set(doc.id, pages);
      for (const p of pages) {
        this.pageMap.set(p.id, p);
        newPageIds.push(p.id);
      }
    }
    if (summary.added.length) this.render();

    if (summary.skipped.length) {
      const list = summary.skipped.map((s) => `• ${s.name} — ${s.reason}`).join('\n');
      showModal({
        title: summary.added.length ? 'Some files were skipped' : "Couldn't add those files",
        body: 'These files were not added:',
        technical: list,
      });
    }

    if (newPageIds.length) {
      this.errorShownThisBatch = false;
      this.queue.enqueue(newPageIds, this.mode);
    }
  }

  // ---------- Deep Read lifecycle ----------

  /** Resolve a ready Deep Read worker — the consent + ~1.4 GB load gate, memoized
   *  so the mode toggle, the per-page re-read, and the queue all share one load. */
  private ensureDeepReady(): Promise<DeepClient> {
    if (this.deep && this.deepState === 'ready') return Promise.resolve(this.deep);
    if (this.deepReadyPromise) return this.deepReadyPromise;
    this.deepReadyPromise = this.loadDeep().catch((e) => {
      this.deepReadyPromise = null; // allow a later retry
      throw e;
    });
    return this.deepReadyPromise;
  }

  /** Consent (first time) + spawn + download/load the Deep Read model. */
  private async loadDeep(): Promise<DeepClient> {
    if (this.deepState === 'off') {
      const ok = await confirmDeepRead(this.caps);
      if (!ok) throw new DeepDeclined();
    }
    if (!this.deep) {
      const ep = this.caps?.webgpu ? 'webgpu' : 'wasm';
      this.deep = new DeepClient({
        debug: isDebug(),
        onnxEp: ep,
        vlmEp: ep,
        handlers: { onError: (err) => showErrorModal(err) },
      });
    }
    this.deepState = 'loading';
    this.deepLoaded = 0;
    this.deepTotal = 0;
    this.updateModeUI();
    this.updateStatusBar();
    try {
      await this.deep.load({
        onLoadProgress: (loaded, total) => {
          this.deepLoaded = loaded;
          this.deepTotal = total;
          this.updateStatusBar();
        },
      });
    } catch (e) {
      // The load may have left the worker dead (a fatal error surfaced via
      // worker.onerror terminates it). Discard the client so the next attempt
      // constructs a fresh worker instead of reusing a dead one (which would hang).
      this.deep?.terminate();
      this.deep = null;
      this.deepState = 'off';
      this.updateModeUI();
      this.updateStatusBar();
      throw e;
    }
    this.deepState = 'ready';
    this.updateModeUI();
    this.updateStatusBar();
    return this.deep;
  }

  /** Switch reading depth. Picking Deep runs the load gate first; declining or a
   *  load failure leaves the app on Quick Read. */
  private async onSelectMode(mode: ReadMode): Promise<void> {
    if (mode === this.mode && this.deepState !== 'off') return;
    if (mode === 'deep') {
      try {
        await this.ensureDeepReady();
      } catch (e) {
        if (!(e instanceof DeepDeclined)) {
          showErrorModal(reportError(e, { context: 'deep:load', capabilities: this.caps }));
        }
        this.mode = 'quick';
        this.updateModeUI();
        return;
      }
    }
    this.mode = mode;
    this.updateModeUI();
  }

  /** Reclaim the ~1.4 GB Deep Read model by terminating its worker (idle only). */
  private unloadDeep(): void {
    if (this.queue.busy) return;
    this.deep?.terminate();
    this.deep = null;
    this.deepState = 'off';
    this.deepReadyPromise = null;
    this.mode = 'quick';
    this.updateModeUI();
    this.updateStatusBar();
  }

  /** Re-read one already-processed page with Deep Read (the review-surface opt-in). */
  private async readPageDeep(page: PageRecord): Promise<void> {
    try {
      await this.ensureDeepReady();
    } catch (e) {
      if (!(e instanceof DeepDeclined)) {
        showErrorModal(reportError(e, { context: 'deep:load', capabilities: this.caps }));
      }
      return;
    }
    const fresh: PageRecord = { ...page, status: 'queued', error: undefined, updatedAt: Date.now() };
    await putPage(fresh);
    this.pageMap.set(page.id, fresh);
    const arr = this.pagesByDoc.get(page.docId);
    if (arr) {
      const i = arr.findIndex((p) => p.id === page.id);
      if (i >= 0) arr[i] = fresh;
    }
    const chip = this.chipEls.get(page.id);
    if (chip) this.applyChip(chip, fresh);
    this.updateRollup(page.docId);
    this.errorShownThisBatch = false;
    this.queue.enqueue([page.id], 'deep');
  }

  private startDeepTicker(): void {
    if (this.deepTicker != null) return;
    this.deepTicker = window.setInterval(() => this.updateStatusBar(), 1000);
  }

  private stopDeepTicker(): void {
    if (this.deepTicker != null) {
      clearInterval(this.deepTicker);
      this.deepTicker = null;
    }
  }

  // ---------- rendering ----------

  private render(): void {
    this.chipEls.clear();
    this.rollupEls.clear();
    this.statusMain = this.statusSub = this.statusBar = this.statusFill = null;
    this.downloadAllBtn = null;

    if (this.docs.length === 0) {
      this.el.replaceChildren(this.buildEmpty());
      return;
    }

    const manager = document.createElement('div');
    manager.className = 'pe-manager';
    manager.append(this.buildStatusBar(), this.buildDocList(), this.buildViewer());
    this.el.replaceChildren(manager);
    this.updateStatusBar();
    this.renderViewer();
  }

  private buildEmpty(): HTMLElement {
    const zone = document.createElement('div');
    zone.className = 'pe-dropzone pe-empty';
    zone.tabIndex = 0;
    zone.setAttribute('role', 'button');
    zone.innerHTML = `
      <h2>Add pages to begin</h2>
      <p>Drop images or PDFs here. Everything runs privately in your browser — nothing is ever uploaded.</p>
      <div class="pe-hint">${this.ready ? 'Quick Read is ready — add images or PDFs to begin.' : escapeHtml(WARMING)}</div>`;
    zone.addEventListener('click', () => this.pickFiles());
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.pickFiles();
      }
    });
    return zone;
  }

  private buildStatusBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'pe-statusbar';

    const status = document.createElement('div');
    status.className = 'pe-status';
    this.statusMain = document.createElement('div');
    this.statusMain.className = 'pe-status-main';
    this.statusSub = document.createElement('div');
    this.statusSub.className = 'pe-status-sub';
    status.append(this.statusMain, this.statusSub);

    this.statusBar = document.createElement('div');
    this.statusBar.className = 'pe-progress';
    const fill = document.createElement('div');
    fill.className = 'pe-progress-fill';
    this.statusBar.appendChild(fill);
    this.statusFill = fill;

    const actions = document.createElement('div');
    actions.className = 'pe-statusbar-actions';
    const add = button('Add files', 'pe-btn', () => this.pickFiles());
    this.stopBtn = button('Stop', 'pe-btn', () => this.queue.cancelAll());
    this.stopBtn.hidden = true;
    this.downloadAllBtn = button('Download all (ZIP)', 'pe-btn pe-btn-primary', () => void this.onDownloadAll());
    actions.append(this.buildModeToggle(), add, this.stopBtn, this.downloadAllBtn);

    bar.append(status, this.statusBar, actions);
    return bar;
  }

  /** Reading-depth toggle: Quick (default) vs Deep (opt-in). Picking Deep runs the
   *  consent + ~1.4 GB load gate; once loaded, an Unload control reclaims it. */
  private buildModeToggle(): HTMLElement {
    this.modeEls.clear();
    const wrap = document.createElement('div');
    wrap.className = 'pe-mode';

    const seg = document.createElement('div');
    seg.className = 'pe-mode-seg';
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Reading depth');
    for (const m of ['quick', 'deep'] as ReadMode[]) {
      const b = document.createElement('button');
      b.className = 'pe-mode-opt';
      b.textContent = m === 'quick' ? 'Quick Read' : 'Deep Read';
      b.addEventListener('click', () => void this.onSelectMode(m));
      this.modeEls.set(m, b);
      seg.appendChild(b);
    }

    this.unloadBtn = button('Unload', 'pe-mode-unload', () => this.unloadDeep());
    this.unloadBtn.title = 'Free the Deep Read model from memory (~1.4 GB)';
    wrap.append(seg, this.unloadBtn);
    this.updateModeUI();
    return wrap;
  }

  private updateModeUI(): void {
    for (const [m, el] of this.modeEls) {
      el.classList.toggle('pe-mode-on', m === this.mode);
      el.disabled = this.deepState === 'loading';
    }
    const deepEl = this.modeEls.get('deep');
    if (deepEl) deepEl.textContent = this.deepState === 'loading' ? 'Deep Read · loading…' : 'Deep Read';
    // Offer Unload only when the model is resident and nothing is mid-read.
    if (this.unloadBtn) this.unloadBtn.hidden = !(this.deepState === 'ready' && !this.queue.busy);
  }

  private buildDocList(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'pe-doclist';
    for (const doc of this.docs) list.appendChild(this.buildDocCard(doc));
    return list;
  }

  private buildDocCard(doc: DocumentRecord): HTMLElement {
    const card = document.createElement('section');
    card.className = 'pe-doc';

    const head = document.createElement('div');
    head.className = 'pe-doc-head';

    const titles = document.createElement('div');
    titles.className = 'pe-doc-titles';
    const name = document.createElement('div');
    name.className = 'pe-doc-name';
    name.textContent = doc.name;
    name.title = doc.name;
    const rollup = document.createElement('div');
    rollup.className = 'pe-doc-rollup';
    this.rollupEls.set(doc.id, rollup);
    titles.append(name, rollup);

    const actions = document.createElement('div');
    actions.className = 'pe-doc-actions';
    const dl = button('', 'pe-iconbtn', () => void this.onDownloadDoc(doc));
    dl.title = 'Download this document’s Markdown';
    dl.setAttribute('aria-label', `Download ${doc.name}`);
    dl.innerHTML = ICON_DOWNLOAD;
    const rm = button('', 'pe-iconbtn', () => this.confirmRemove(doc));
    rm.title = 'Remove this document';
    rm.setAttribute('aria-label', `Remove ${doc.name}`);
    rm.innerHTML = ICON_TRASH;
    actions.append(dl, rm);

    head.append(titles, actions);

    const chips = document.createElement('div');
    chips.className = 'pe-pagechips';
    for (const page of this.pagesByDoc.get(doc.id) ?? []) chips.appendChild(this.buildChip(page));

    card.append(head, chips);
    this.updateRollup(doc.id);
    return card;
  }

  private buildChip(page: PageRecord): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.className = 'pe-chip';
    chip.dataset.pageId = page.id;
    chip.addEventListener('click', () => this.onChipClick(page.id));
    this.chipEls.set(page.id, chip);
    this.applyChip(chip, page);
    return chip;
  }

  private applyChip(chip: HTMLButtonElement, page: PageRecord): void {
    chip.dataset.status = page.status;
    chip.classList.toggle('pe-selected', page.id === this.selectedPageId);
    const clickable = PROCESSED.has(page.status) || page.status === 'error' || page.status === 'cancelled';
    chip.disabled = !clickable;
    const busy = page.status === 'processing' || page.status === 'rasterizing';
    chip.innerHTML = busy ? `<span class="pe-spin pe-spin-sm"></span>${page.pageNo}` : String(page.pageNo);
    chip.title = `Page ${page.pageNo} — ${CHIP_TITLE[page.status]}`;
  }

  // ---------- viewer ----------

  private buildViewer(): HTMLElement {
    const v = document.createElement('div');
    v.className = 'pe-viewer';
    return v;
  }

  private renderViewer(): void {
    const v = this.el.querySelector<HTMLElement>('.pe-viewer');
    if (!v) return;

    this.teardownSurface();

    if (!this.selectedPageId) {
      v.innerHTML = `<div class="pe-viewer-empty">${escapeHtml(
        'Select a finished page to review what Private Eye read.',
      )}</div>`;
      return;
    }
    const page = this.pageMap.get(this.selectedPageId);
    const doc = page && this.docs.find((d) => d.id === page.docId);
    if (!page || !doc || !PROCESSED.has(page.status)) {
      v.innerHTML = `<div class="pe-viewer-empty">${escapeHtml('This page hasn’t been read yet.')}</div>`;
      return;
    }

    const surface = new ReviewSurface(doc, page, this.quick, () => void this.readPageDeep(page));
    this.surface = surface;
    v.replaceChildren(surface.el);
    void surface.load().catch((e) => {
      showErrorModal({
        kind: 'Unknown',
        userMessage: 'Couldn’t open the review for this page.',
        technical: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
    });
  }

  /** Tear down the current review surface (flushes its pending save, frees the
   *  page raster URL). Called before opening another page or re-rendering. */
  private teardownSurface(): void {
    if (this.surface) {
      this.surface.destroy();
      this.surface = null;
    }
  }

  // ---------- interactions ----------

  private onChipClick(pageId: PageId): void {
    const page = this.pageMap.get(pageId);
    if (!page) return;
    if (PROCESSED.has(page.status)) {
      this.selectPage(pageId);
    } else if (page.status === 'error') {
      this.showPageError(page);
    } else if (page.status === 'cancelled') {
      this.requeuePage(page);
    }
  }

  private requeuePage(page: PageRecord): void {
    void putPage({ ...page, status: 'queued', error: undefined, updatedAt: Date.now() }).then(() => {
      const fresh: PageRecord = { ...page, status: 'queued', error: undefined };
      this.pageMap.set(page.id, fresh);
      const arr = this.pagesByDoc.get(page.docId);
      if (arr) {
        const i = arr.findIndex((p) => p.id === page.id);
        if (i >= 0) arr[i] = fresh;
      }
      const chip = this.chipEls.get(page.id);
      if (chip) this.applyChip(chip, fresh);
      this.updateRollup(page.docId);
      this.errorShownThisBatch = false;
      this.queue.enqueue([page.id]);
    });
  }

  private selectPage(pageId: PageId): void {
    const prev = this.selectedPageId;
    this.selectedPageId = pageId;
    if (prev && prev !== pageId) {
      const prevChip = this.chipEls.get(prev);
      if (prevChip) prevChip.classList.remove('pe-selected');
    }
    this.chipEls.get(pageId)?.classList.add('pe-selected');
    this.renderViewer();
  }

  private showPageError(page: PageRecord): void {
    showModal({
      title: 'This page couldn’t be read',
      body: page.error ?? 'Something went wrong while reading this page.',
      actions: [
        { label: 'Try again', primary: true, onClick: () => this.requeuePage(page) },
        { label: 'Close' },
      ],
    });
  }

  private confirmRemove(doc: DocumentRecord): void {
    showModal({
      title: `Remove “${doc.name}”?`,
      body: 'This deletes the document and everything read from it from this browser. It cannot be undone.',
      actions: [
        { label: 'Remove', primary: true, onClick: () => void this.removeDoc(doc) },
        { label: 'Cancel' },
      ],
    });
  }

  private async removeDoc(doc: DocumentRecord): Promise<void> {
    const pages = this.pagesByDoc.get(doc.id) ?? [];
    this.queue.forget(pages.map((p) => p.id));
    await deleteDocumentCascade(doc.id);

    for (const p of pages) {
      this.pageMap.delete(p.id);
      this.chipEls.delete(p.id);
      if (this.selectedPageId === p.id) this.selectedPageId = null;
    }
    this.pagesByDoc.delete(doc.id);
    this.docs = this.docs.filter((d) => d.id !== doc.id);
    this.render();
  }

  private async onDownloadDoc(doc: DocumentRecord): Promise<void> {
    const md = await documentMarkdown(doc.id);
    if (!md.trim()) {
      showModal({ title: 'Nothing to download yet', body: 'This document has no finished pages.' });
      return;
    }
    triggerDownload(new Blob([md], { type: 'text/markdown' }), markdownName(doc));
  }

  private async onDownloadAll(): Promise<void> {
    if (this.downloadAllBtn) this.downloadAllBtn.disabled = true;
    try {
      const { blob, count } = await exportAllZip();
      if (count === 0) {
        showModal({ title: 'Nothing to download yet', body: 'No pages have finished reading.' });
        return;
      }
      triggerDownload(blob, 'private-eye-markdown.zip');
    } catch (e) {
      showErrorModal({
        kind: 'Unknown',
        userMessage: "Couldn't build the download.",
        technical: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
    } finally {
      this.updateStatusBar();
    }
  }

  // ---------- queue events ----------

  private onQueueEvent(e: QueueEvent): void {
    switch (e.type) {
      case 'busy':
        this.currentPageId = e.pageId;
        this.currentMode = e.mode;
        this.currentStage = 'loading';
        this.currentDeepPhase = 'preparing';
        this.currentDeepIndex = undefined;
        this.currentDeepTotal = undefined;
        if (e.mode === 'deep') {
          this.stopRotation();
          this.deepStartedAt = performance.now();
          this.startDeepTicker();
        } else {
          this.stopDeepTicker();
          this.startRotation();
        }
        this.updateModeUI();
        this.updateStatusBar();
        break;
      case 'stage':
        if (e.pageId === this.currentPageId) {
          this.currentStage = e.stage;
          this.updateStatusBar();
        }
        break;
      case 'deep-phase':
        if (e.pageId === this.currentPageId) {
          this.currentDeepPhase = e.phase;
          this.currentDeepIndex = e.index;
          this.currentDeepTotal = e.total;
          this.updateStatusBar();
        }
        break;
      case 'page': {
        this.pageMap.set(e.page.id, e.page);
        const arr = this.pagesByDoc.get(e.page.docId);
        if (arr) {
          const i = arr.findIndex((p) => p.id === e.page.id);
          if (i >= 0) arr[i] = e.page;
        }
        const chip = this.chipEls.get(e.page.id);
        if (chip) this.applyChip(chip, e.page);
        this.updateRollup(e.page.docId);
        this.updateStatusBar();
        // Auto-open the first finished page, and refresh the viewer if the
        // currently-open page just finished.
        if (PROCESSED.has(e.page.status)) {
          if (!this.selectedPageId) this.selectPage(e.page.id);
          else if (this.selectedPageId === e.page.id) this.renderViewer();
        }
        break;
      }
      case 'error':
        if (!this.errorShownThisBatch) {
          this.errorShownThisBatch = true;
          showErrorModal(e.error);
        }
        break;
      case 'idle':
        this.currentPageId = null;
        this.stopRotation();
        this.stopDeepTicker();
        this.errorShownThisBatch = false;
        this.updateModeUI(); // batch ended → Unload becomes available again
        this.updateStatusBar();
        break;
    }
  }

  // ---------- status bar + rollups ----------

  private startRotation(): void {
    if (this.rotateTimer != null) return;
    this.rotateTimer = window.setInterval(() => {
      if (this.currentStage === 'analyzing') {
        this.tick++;
        this.updateStatusBar();
      }
    }, 2500);
  }

  private stopRotation(): void {
    if (this.rotateTimer != null) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }
  }

  private counts(): { total: number; read: number; done: number } {
    let total = 0;
    let read = 0;
    let done = 0;
    for (const pages of this.pagesByDoc.values()) {
      for (const p of pages) {
        total++;
        if (PROCESSED.has(p.status)) {
          read++;
          done++;
        } else if (TERMINAL.has(p.status)) {
          done++;
        }
      }
    }
    return { total, read, done };
  }

  private updateStatusBar(): void {
    if (!this.statusMain || !this.statusSub || !this.statusBar || !this.statusFill) return;
    const { total, read, done } = this.counts();

    if (this.downloadAllBtn) this.downloadAllBtn.disabled = read === 0;
    if (this.stopBtn) this.stopBtn.hidden = !this.queue.busy;

    // The one-time Deep Read model download takes over the status line while it
    // runs (the queue waits on it). Non-blocking — the rest of the UI stays usable.
    if (this.deepState === 'loading') {
      this.statusMain.textContent = SPECIALIST;
      if (this.deepTotal > 0) {
        const pct = Math.round((this.deepLoaded / this.deepTotal) * 100);
        this.statusSub.textContent = `Downloading the Deep Read model — ${fmtBytes(this.deepLoaded)} / ${fmtBytes(this.deepTotal)} (${pct}%), one time. Quick Read still works.`;
        this.statusBar.classList.remove('indeterminate');
        this.statusFill.style.width = `${(this.deepLoaded / this.deepTotal) * 100}%`;
      } else {
        this.statusSub.textContent = 'Reaching the model library…';
        this.statusBar.classList.add('indeterminate');
        this.statusFill.style.width = '';
      }
      return;
    }

    if (this.queue.busy && this.currentPageId) {
      const page = this.pageMap.get(this.currentPageId);
      const doc = page && this.docs.find((d) => d.id === page.docId);
      this.statusBar.classList.remove('indeterminate');
      this.statusFill.style.width = `${total ? (done / total) * 100 : 0}%`;
      if (this.currentMode === 'deep') {
        const secs = Math.max(0, Math.round((performance.now() - this.deepStartedAt) / 1000));
        this.statusMain.textContent = deepPhaseMessage(this.currentDeepPhase, this.currentDeepIndex, this.currentDeepTotal);
        this.statusSub.textContent =
          page && doc ? `${doc.name} · page ${page.pageNo} · ${secs}s · ${read} of ${total} read` : `${secs}s · ${read} of ${total} read`;
      } else {
        this.statusMain.textContent = this.ready ? stageMessage(this.currentStage, this.tick) : WARMING;
        this.statusSub.textContent =
          page && doc ? `${doc.name} · page ${page.pageNo} · ${read} of ${total} read` : `${read} of ${total} read`;
      }
    } else {
      this.statusMain.textContent = read > 0 && done === total ? CASE_CLOSED : 'All caught up.';
      this.statusSub.textContent = `${read} of ${total} read`;
      this.statusBar.classList.remove('indeterminate');
      this.statusFill.style.width = `${total ? (done / total) * 100 : 0}%`;
    }
  }

  private updateRollup(docId: string): void {
    const el = this.rollupEls.get(docId);
    if (!el) return;
    const pages = this.pagesByDoc.get(docId) ?? [];
    const total = pages.length;
    const read = pages.filter((p) => PROCESSED.has(p.status)).length;
    const review = pages.filter((p) => p.status === 'needs-review').length;
    const errored = pages.filter((p) => p.status === 'error').length;
    const parts = [`${read}/${total} read`];
    if (review) parts.push(`${review} to review`);
    if (errored) parts.push(`${errored} failed`);
    el.textContent = parts.join(' · ');
  }
}

const CHIP_TITLE: Record<PageRecord['status'], string> = {
  queued: 'waiting',
  rasterizing: 'rendering…',
  processing: 'reading…',
  'needs-review': 'read — a look is suggested',
  done: 'read',
  error: 'couldn’t be read — click for details',
  cancelled: 'cancelled',
};

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  if (label) b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 4 5-4"/><path d="M5 21h14"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/></svg>`;
