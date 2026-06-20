/**
 * The workspace: a multi-file document manager and the app's working surface.
 * Users add images and PDFs; pages are persisted and processed one at a time by
 * the queue (models stay resident), survive reloads, and show up as tiles in a
 * thin horizontal carousel. Selecting a finished tile opens it in the review
 * surface — a zoomable scan beside the structured Markdown.
 *
 * Reading depth is deliberately simple: Quick Read runs automatically on every
 * page; Deep Read is a per-page escalation offered from the review surface. There
 * is no global mode toggle, so the two never conflict — and the status line always
 * names which one is running right now.
 */
import { QuickClient } from '../workers/client.ts';
import { DeepClient } from '../workers/deep-client.ts';
import { ProcessingQueue, type QueueEvent } from '../orchestrate/queue.ts';
import { ingestFiles } from '../orchestrate/ingest.ts';
import {
  allDocuments,
  deleteDocumentCascade,
  getResult,
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
import { pageImageBlob } from '../orchestrate/raster.ts';
import {
  PROCESSED,
  TERMINAL,
  type DocumentRecord,
  type PageId,
  type PageRecord,
  type PageStatus,
  type ReadMode,
} from '../orchestrate/types.ts';
import { ReviewSurface } from '../review/surface.ts';
import { showErrorModal, showModal } from './modal.ts';
import { confirmDeepRead, DeepDeclined } from './deep-consent.ts';
import { escapeHtml, fmtBytes } from './progress.ts';
import { makeThumbUrl } from './thumbs.ts';
import { CASE_CLOSED, deepPhaseMessage, SPECIALIST, stageMessage, WARMING } from './copy.ts';
import type { DeepPhaseKind, StageKey } from '../workers/protocol.ts';
import type { Capabilities } from '../runtime/capabilities.ts';
import { isDebug, log } from '../runtime/logger.ts';
import { reportError } from '../runtime/errors.ts';

const ACCEPT = 'image/*,application/pdf,.pdf';

export class Workspace {
  readonly el: HTMLElement;
  private readonly queue: ProcessingQueue;

  private docs: DocumentRecord[] = [];
  private readonly pagesByDoc = new Map<string, PageRecord[]>();
  private readonly pageMap = new Map<PageId, PageRecord>();
  private readonly tileEls = new Map<PageId, HTMLButtonElement>();
  private readonly rollupEls = new Map<string, HTMLElement>();

  private selectedPageId: PageId | null = null;
  private surface: ReviewSurface | null = null;
  private ready = false;

  // app bar / status line
  private runLight: HTMLElement | null = null;
  private runMode: HTMLElement | null = null;
  private runText: HTMLElement | null = null;
  private runSub: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private progressFill: HTMLElement | null = null;
  private addBtn: HTMLButtonElement | null = null;
  private downloadAllBtn: HTMLButtonElement | null = null;
  private deepAllBtn: HTMLButtonElement | null = null;
  private stopBtn: HTMLButtonElement | null = null;
  private deepChip: HTMLButtonElement | null = null;

  // carousel + review host
  private carouselEl: HTMLElement | null = null;
  private reviewHost: HTMLElement | null = null;

  // thumbnails (lazy, cached, revoked on doc removal)
  private readonly thumbUrls = new Map<PageId, string>();
  private readonly thumbPending = new Set<PageId>();
  private thumbObserver: IntersectionObserver | null = null;
  private carnavRO: ResizeObserver | null = null;

  // Deep Read (opt-in, per-page)
  private deep: DeepClient | null = null;
  private deepState: 'off' | 'loading' | 'ready' = 'off';
  /** Memoized consent + load, so every per-page escalation shares one gate. */
  private deepReadyPromise: Promise<DeepClient> | null = null;
  private deepLoaded = 0;
  private deepTotal = 0;

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
      // Everything is read with Quick Read automatically; Deep is a per-page opt-in.
      this.queue.enqueue(newPageIds);
    }
  }

  // ---------- Deep Read lifecycle (per-page escalation) ----------

  /** Resolve a ready Deep Read worker — the consent + ~1.4 GB load gate, memoized
   *  so the per-page re-read and the queue share one load. */
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
    this.updateDeepChip();
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
      // The load may have left the worker dead; discard it so the next attempt
      // constructs a fresh one instead of reusing a dead one (which would hang).
      this.deep?.terminate();
      this.deep = null;
      this.deepState = 'off';
      this.updateDeepChip();
      this.updateStatusBar();
      throw e;
    }
    this.deepState = 'ready';
    this.updateDeepChip();
    this.updateStatusBar();
    return this.deep;
  }

  /** Reclaim the ~1.4 GB Deep Read model by terminating its worker (idle only). */
  private unloadDeep(): void {
    if (this.queue.busy) return;
    this.deep?.terminate();
    this.deep = null;
    this.deepState = 'off';
    this.deepReadyPromise = null;
    this.updateDeepChip();
    this.updateStatusBar();
  }

  /** Re-read one already-processed page with Deep Read (the review-surface opt-in). */
  private readPageDeep(page: PageRecord): Promise<void> {
    return this.escalate([page]);
  }

  /** Escalate a set of pages to Deep Read: clear the consent + ~1.4 GB load gate
   *  once, re-mark every page `queued`, then enqueue them all in one deep batch.
   *  The shared path behind the per-page button and the carousel's per-document /
   *  Deep-Read-all actions. The queue processes them sequentially. */
  private async escalate(pages: PageRecord[]): Promise<void> {
    if (!pages.length) return;
    try {
      await this.ensureDeepReady();
    } catch (e) {
      if (!(e instanceof DeepDeclined)) {
        showErrorModal(reportError(e, { context: 'deep:load', capabilities: this.caps }));
      }
      return;
    }
    const ids: PageId[] = [];
    const docs = new Set<string>();
    for (const page of pages) {
      const fresh: PageRecord = { ...page, status: 'queued', error: undefined, updatedAt: Date.now() };
      await putPage(fresh);
      this.pageMap.set(page.id, fresh);
      const arr = this.pagesByDoc.get(page.docId);
      if (arr) {
        const i = arr.findIndex((p) => p.id === page.id);
        if (i >= 0) arr[i] = fresh;
      }
      const tile = this.tileEls.get(page.id);
      if (tile) this.applyTile(tile, fresh);
      ids.push(page.id);
      docs.add(page.docId);
    }
    for (const docId of docs) this.updateRollup(docId);
    this.errorShownThisBatch = false;
    this.queue.enqueue(ids, 'deep');
  }

  /** The pages a batch Deep Read will touch: those currently read by Quick Read
   *  (an exact-transcription result, pipeline 'E') — exactly the pages that offer
   *  the per-page "Deep Read this page" button. Skips pages already read by Deep
   *  Read ('G') and pages not yet read / failed. A Deep→exact fallback is stored
   *  as 'E', so it is correctly re-eligible. */
  private async deepCandidates(pages: PageRecord[]): Promise<PageRecord[]> {
    const out: PageRecord[] = [];
    for (const p of pages) {
      if (!PROCESSED.has(p.status)) continue;
      const r = await getResult(p.id);
      if (r?.pipeline === 'E') out.push(p);
    }
    return out;
  }

  /** Deep Read every Quick-Read page in one document (the carousel per-doc action). */
  private async readDocDeep(doc: DocumentRecord): Promise<void> {
    const pages = await this.deepCandidates(this.pagesByDoc.get(doc.id) ?? []);
    this.confirmDeep(pages, `Deep Read “${doc.name}”`, 'this document');
  }

  /** Deep Read every Quick-Read page across all documents (the app-bar action). */
  private async readAllDeep(): Promise<void> {
    const all: PageRecord[] = [];
    for (const doc of this.docs) all.push(...(this.pagesByDoc.get(doc.id) ?? []));
    const pages = await this.deepCandidates(all);
    this.confirmDeep(pages, 'Deep Read all documents', 'these documents');
  }

  /** Confirm a batch Deep Read (stating the page count) before escalating, or
   *  explain when there's nothing left to escalate. */
  private confirmDeep(pages: PageRecord[], title: string, scope: string): void {
    if (!pages.length) {
      showModal({
        title: 'Nothing to Deep Read',
        body: `Every readable page in ${scope} has already been Deep Read. Pages still being read or that failed aren’t included.`,
      });
      return;
    }
    const n = pages.length;
    const noun = n === 1 ? 'page' : 'pages';
    showModal({
      title,
      body: `This re-reads ${n} ${noun} with the heavier AI-assisted model, one page at a time. It can take a while; each page’s current reading stays until its Deep Read finishes.`,
      actions: [
        { label: `Deep Read ${n} ${noun}`, primary: true, onClick: () => void this.escalate(pages) },
        { label: 'Cancel' },
      ],
    });
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
    this.tileEls.clear();
    this.rollupEls.clear();
    this.thumbObserver?.disconnect();
    this.thumbObserver = null;
    this.runLight = this.runMode = this.runText = this.runSub = null;
    this.progressBar = this.progressFill = null;
    this.addBtn = this.downloadAllBtn = this.stopBtn = this.deepChip = null;
    this.carouselEl = this.reviewHost = null;

    if (this.docs.length === 0) {
      this.el.replaceChildren(this.buildEmpty());
      return;
    }

    this.el.replaceChildren(this.buildAppBar(), this.buildCarousel(), this.buildReviewHost());
    this.updateStatusBar();
    this.updateDeepChip();
    this.renderViewer();
    this.observeVisibleThumbs();
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

  /** The thin top bar: a live status line that names the running mode, a slim
   *  progress bar, and the global actions (Add / Stop / Download all / Unload). */
  private buildAppBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'pe-appbar';

    const status = document.createElement('div');
    status.className = 'pe-run';
    status.setAttribute('role', 'status');
    this.runLight = document.createElement('span');
    this.runLight.className = 'pe-runlight';
    this.runMode = document.createElement('span');
    this.runMode.className = 'pe-runmode';
    this.runText = document.createElement('span');
    this.runText.className = 'pe-runtext';
    const line = document.createElement('div');
    line.className = 'pe-runline';
    line.append(this.runLight, this.runMode, this.runText);
    this.runSub = document.createElement('div');
    this.runSub.className = 'pe-runsub';
    status.append(line, this.runSub);

    this.progressBar = document.createElement('div');
    this.progressBar.className = 'pe-progress';
    this.progressFill = document.createElement('div');
    this.progressFill.className = 'pe-progress-fill';
    this.progressBar.appendChild(this.progressFill);

    const actions = document.createElement('div');
    actions.className = 'pe-appbar-actions';
    this.deepChip = button('', 'pe-chip-deep', () => this.unloadDeep());
    this.deepChip.hidden = true;
    this.addBtn = button('Add files', 'pe-btn', () => this.pickFiles());
    this.stopBtn = button('Stop', 'pe-btn', () => this.queue.cancelAll());
    this.stopBtn.hidden = true;
    this.deepAllBtn = button('Deep Read all', 'pe-btn', () => void this.readAllDeep());
    this.downloadAllBtn = button('Download all (ZIP)', 'pe-btn pe-btn-primary', () => void this.onDownloadAll());
    actions.append(this.deepChip, this.addBtn, this.stopBtn, this.deepAllBtn, this.downloadAllBtn);

    bar.append(status, this.progressBar, actions);
    return bar;
  }

  /** The document carousel: a thin, horizontally-scrollable filmstrip of page
   *  thumbnails grouped by document. Deliberately bounded in height so the scan +
   *  Markdown panes below get the page's width. */
  private buildCarousel(): HTMLElement {
    const scroller = document.createElement('div');
    scroller.className = 'pe-carousel';
    this.carouselEl = scroller;
    // One shared observer keeps every group's page-nav (edge fades + chevrons) in
    // sync; reset it on each rebuild so we never observe detached tile strips.
    this.carnavRO?.disconnect();
    this.carnavRO = new ResizeObserver((entries) => {
      for (const e of entries) this.syncCarnav(e.target as HTMLElement);
    });
    for (const doc of this.docs) scroller.appendChild(this.buildDocGroup(doc));
    const add = button('+', 'pe-tile-add', () => this.pickFiles());
    add.title = 'Add more images or PDFs';
    add.setAttribute('aria-label', 'Add files');
    scroller.appendChild(add);
    return scroller;
  }

  private buildDocGroup(doc: DocumentRecord): HTMLElement {
    const group = document.createElement('section');
    group.className = 'pe-cargroup';

    const head = document.createElement('div');
    head.className = 'pe-cargroup-head';

    const titles = document.createElement('div');
    titles.className = 'pe-cargroup-titles';
    const name = document.createElement('div');
    name.className = 'pe-cargroup-name';
    name.textContent = doc.name;
    name.title = doc.name;
    const rollup = document.createElement('div');
    rollup.className = 'pe-cargroup-rollup';
    this.rollupEls.set(doc.id, rollup);
    titles.append(name, rollup);

    const actions = document.createElement('div');
    actions.className = 'pe-cargroup-actions';
    const deep = button('', 'pe-iconbtn', () => void this.readDocDeep(doc));
    deep.title = 'Deep Read this document';
    deep.setAttribute('aria-label', `Deep Read ${doc.name}`);
    deep.innerHTML = ICON_DEEP;
    const dl = button('', 'pe-iconbtn', () => void this.onDownloadDoc(doc));
    dl.title = 'Download this document’s Markdown';
    dl.setAttribute('aria-label', `Download ${doc.name}`);
    dl.innerHTML = ICON_DOWNLOAD;
    const rm = button('', 'pe-iconbtn', () => this.confirmRemove(doc));
    rm.title = 'Remove this document';
    rm.setAttribute('aria-label', `Remove ${doc.name}`);
    rm.innerHTML = ICON_TRASH;
    actions.append(deep, dl, rm);

    const pages = this.pagesByDoc.get(doc.id) ?? [];
    if (pages.length > 1) {
      const count = document.createElement('div');
      count.className = 'pe-cargroup-count';
      count.textContent = `${pages.length} pages`;
      head.append(titles, count, actions);
    } else {
      head.append(titles, actions);
    }

    const tiles = document.createElement('div');
    tiles.className = 'pe-cartiles';
    for (const page of pages) tiles.appendChild(this.buildTile(page));

    // Wrap the fixed-width tile strip with hover-revealed page-nav chevrons. The
    // chevrons are siblings of the strip so syncCarnav can reach them via DOM order.
    const wrap = document.createElement('div');
    wrap.className = 'pe-cartiles-wrap';
    const prev = button('', 'pe-carnav pe-carnav-prev', () => this.pageTiles(tiles, -1));
    prev.setAttribute('aria-label', 'Previous pages');
    prev.tabIndex = -1;
    prev.innerHTML = ICON_CHEVRON_LEFT;
    const next = button('', 'pe-carnav pe-carnav-next', () => this.pageTiles(tiles, 1));
    next.setAttribute('aria-label', 'Next pages');
    next.tabIndex = -1;
    next.innerHTML = ICON_CHEVRON_RIGHT;
    wrap.append(prev, tiles, next);
    tiles.addEventListener('scroll', () => this.syncCarnav(tiles), { passive: true });
    this.carnavRO?.observe(tiles);

    group.append(head, wrap);
    this.updateRollup(doc.id);
    return group;
  }

  private buildTile(page: PageRecord): HTMLButtonElement {
    const tile = document.createElement('button');
    tile.className = 'pe-tile';
    tile.dataset.pageId = page.id;

    const fig = document.createElement('span');
    fig.className = 'pe-tile-fig';
    const img = document.createElement('img');
    img.className = 'pe-tile-img';
    img.alt = '';
    img.style.display = 'none';
    const dot = document.createElement('span');
    dot.className = 'pe-tile-dot';
    fig.append(img, dot);

    const no = document.createElement('span');
    no.className = 'pe-tile-no';
    no.textContent = String(page.pageNo);

    tile.append(fig, no);
    tile.addEventListener('click', () => this.onTileClick(page.id));
    this.tileEls.set(page.id, tile);
    this.applyTile(tile, page);
    return tile;
  }

  private applyTile(tile: HTMLButtonElement, page: PageRecord): void {
    tile.dataset.status = page.status;
    tile.classList.toggle('pe-selected', page.id === this.selectedPageId);
    const clickable = PROCESSED.has(page.status) || page.status === 'error' || page.status === 'cancelled';
    tile.disabled = !clickable;
    const busy = page.status === 'processing' || page.status === 'rasterizing';
    const dot = tile.querySelector<HTMLElement>('.pe-tile-dot');
    if (dot) dot.innerHTML = busy ? '<span class="pe-spin pe-spin-sm"></span>' : '';
    tile.title = `Page ${page.pageNo} — ${TILE_TITLE[page.status]}`;
  }

  /** Advance the page filmstrip by ~one viewport, keeping a tile of overlap for
   *  context. The strip is overflow:hidden and only ever moves here — never via a
   *  scrollbar — so it can't fight the carousel's own horizontal scroll. */
  private pageTiles(tiles: HTMLElement, dir: 1 | -1): void {
    const step = Math.max(tiles.clientWidth - 68, 120);
    tiles.scrollBy({ left: dir * step, behavior: 'smooth' });
  }

  /** Reflect scroll position onto the edge fades and chevron visibility. Driven by
   *  the strip's scroll events and the ResizeObserver (which also fires once on
   *  observe, supplying the initial state). */
  private syncCarnav(tiles: HTMLElement): void {
    const prev = tiles.previousElementSibling as HTMLElement | null;
    const next = tiles.nextElementSibling as HTMLElement | null;
    const max = tiles.scrollWidth - tiles.clientWidth;
    const overflowing = max > 1;
    const atStart = tiles.scrollLeft <= 1;
    const atEnd = tiles.scrollLeft >= max - 1;
    tiles.style.setProperty('--fade-l', !overflowing || atStart ? '0px' : '18px');
    tiles.style.setProperty('--fade-r', !overflowing || atEnd ? '0px' : '22px');
    if (prev) prev.hidden = !overflowing || atStart;
    if (next) next.hidden = !overflowing || atEnd;
  }

  private buildReviewHost(): HTMLElement {
    const host = document.createElement('div');
    host.className = 'pe-review-host';
    this.reviewHost = host;
    return host;
  }

  // ---------- thumbnails ----------

  /** (Re)observe every processed tile so its thumbnail loads when it scrolls into
   *  view. PDF thumbnails rasterize on demand, so we only fetch what's visible. */
  private observeVisibleThumbs(): void {
    if (!this.carouselEl) return;
    this.thumbObserver?.disconnect();
    this.thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const id = (e.target as HTMLElement).dataset.pageId as PageId | undefined;
          this.thumbObserver?.unobserve(e.target);
          if (id) void this.loadThumb(id);
        }
      },
      { root: this.carouselEl, rootMargin: '300px' },
    );
    for (const [id, tile] of this.tileEls) {
      const page = this.pageMap.get(id);
      if (page && PROCESSED.has(page.status) && !this.thumbUrls.has(id)) this.thumbObserver.observe(tile);
      else if (this.thumbUrls.has(id)) this.setTileImg(id, this.thumbUrls.get(id)!);
    }
  }

  private async loadThumb(id: PageId): Promise<void> {
    if (this.thumbUrls.has(id)) {
      this.setTileImg(id, this.thumbUrls.get(id)!);
      return;
    }
    if (this.thumbPending.has(id)) return;
    const page = this.pageMap.get(id);
    if (!page || !PROCESSED.has(page.status)) return;
    const doc = this.docs.find((d) => d.id === page.docId);
    if (!doc) return;
    this.thumbPending.add(id);
    try {
      const blob = await pageImageBlob(doc, page);
      const url = await makeThumbUrl(blob);
      this.thumbUrls.set(id, url);
      this.setTileImg(id, url);
    } catch (e) {
      log.debug('thumbnail unavailable', e);
    } finally {
      this.thumbPending.delete(id);
    }
  }

  private setTileImg(id: PageId, url: string): void {
    const img = this.tileEls.get(id)?.querySelector<HTMLImageElement>('.pe-tile-img');
    if (img) {
      img.src = url;
      img.style.display = 'block';
    }
  }

  // ---------- viewer ----------

  private renderViewer(): void {
    const host = this.reviewHost;
    if (!host) return;

    this.teardownSurface();

    if (!this.selectedPageId) {
      host.innerHTML = `<div class="pe-viewer-empty">${escapeHtml(
        'Select a finished page from the strip above to review what Private Eye read.',
      )}</div>`;
      return;
    }
    const page = this.pageMap.get(this.selectedPageId);
    const doc = page && this.docs.find((d) => d.id === page.docId);
    if (!page || !doc || !PROCESSED.has(page.status)) {
      host.innerHTML = `<div class="pe-viewer-empty">${escapeHtml('This page hasn’t been read yet.')}</div>`;
      return;
    }

    const surface = new ReviewSurface(
      doc,
      page,
      this.quick,
      () => void this.readPageDeep(page),
      (needs) => this.onReviewStatus(page.id, needs),
    );
    this.surface = surface;
    host.replaceChildren(surface.el);
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

  /** Push a page's live review state (from its open review surface) back to the
   *  carousel tile + persisted status, so resolving or reverting flagged spots —
   *  or moving the sensitivity threshold — flips the indicator. Only ever toggles
   *  between the two "read successfully" states. */
  private onReviewStatus(pageId: PageId, needs: boolean): void {
    const page = this.pageMap.get(pageId);
    if (!page || !PROCESSED.has(page.status)) return;
    const status: PageStatus = needs ? 'needs-review' : 'done';
    if (status === page.status) return;
    const fresh: PageRecord = { ...page, status, updatedAt: Date.now() };
    this.pageMap.set(pageId, fresh);
    const arr = this.pagesByDoc.get(page.docId);
    if (arr) {
      const i = arr.findIndex((p) => p.id === pageId);
      if (i >= 0) arr[i] = fresh;
    }
    const tile = this.tileEls.get(pageId);
    if (tile) this.applyTile(tile, fresh);
    this.updateRollup(page.docId);
    void putPage(fresh);
  }

  // ---------- interactions ----------

  private onTileClick(pageId: PageId): void {
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
      const tile = this.tileEls.get(page.id);
      if (tile) this.applyTile(tile, fresh);
      this.updateRollup(page.docId);
      this.errorShownThisBatch = false;
      this.queue.enqueue([page.id]);
    });
  }

  private selectPage(pageId: PageId): void {
    const prev = this.selectedPageId;
    this.selectedPageId = pageId;
    if (prev && prev !== pageId) this.tileEls.get(prev)?.classList.remove('pe-selected');
    const tile = this.tileEls.get(pageId);
    tile?.classList.add('pe-selected');
    tile?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
      this.tileEls.delete(p.id);
      const url = this.thumbUrls.get(p.id);
      if (url) {
        URL.revokeObjectURL(url);
        this.thumbUrls.delete(p.id);
      }
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
        this.updateDeepChip();
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
        const tile = this.tileEls.get(e.page.id);
        if (tile) this.applyTile(tile, e.page);
        this.updateRollup(e.page.docId);
        this.updateStatusBar();
        // A re-read can change a page's content: drop any stale thumbnail so it
        // regenerates, and refresh the open page if it just finished.
        if (PROCESSED.has(e.page.status)) {
          const url = this.thumbUrls.get(e.page.id);
          if (url) {
            URL.revokeObjectURL(url);
            this.thumbUrls.delete(e.page.id);
          }
          if (tile) void this.loadThumb(e.page.id);
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
        this.updateDeepChip(); // batch ended → Unload becomes available again
        this.updateStatusBar();
        break;
    }
  }

  // ---------- status line + rollups ----------

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

  /** Show "Deep model loaded · Unload" only when the model is resident and nothing
   *  is mid-read (terminating its worker during a decode would lose work). */
  private updateDeepChip(): void {
    if (!this.deepChip) return;
    const show = this.deepState === 'ready' && !this.queue.busy;
    this.deepChip.hidden = !show;
    if (show) {
      this.deepChip.textContent = 'Deep model loaded · Unload';
      this.deepChip.title = 'Free the Deep Read model from memory (~1.4 GB)';
    }
  }

  private setRun(mode: string, text: string, sub: string, busy: boolean): void {
    if (this.runMode) {
      this.runMode.textContent = mode;
      this.runMode.hidden = mode === '';
    }
    if (this.runText) this.runText.textContent = text;
    if (this.runSub) this.runSub.textContent = sub;
    if (this.runLight) {
      this.runLight.classList.toggle('pe-runlight-on', busy);
      this.runLight.dataset.mode = busy ? this.currentMode : '';
    }
  }

  private updateStatusBar(): void {
    if (!this.runText || !this.progressBar || !this.progressFill) return;
    const { total, read, done } = this.counts();

    if (this.downloadAllBtn) this.downloadAllBtn.disabled = read === 0;
    if (this.deepAllBtn) this.deepAllBtn.disabled = read === 0;
    if (this.stopBtn) this.stopBtn.hidden = !this.queue.busy;

    // The one-time Deep Read model download takes over the status line while it
    // runs (the queue waits on it). Non-blocking — the rest of the UI stays usable.
    if (this.deepState === 'loading') {
      if (this.deepTotal > 0) {
        const pct = Math.round((this.deepLoaded / this.deepTotal) * 100);
        this.setRun(
          'Deep Read',
          SPECIALIST,
          `Downloading the Deep Read model — ${fmtBytes(this.deepLoaded)} / ${fmtBytes(this.deepTotal)} (${pct}%), one time. Quick Read still works.`,
          true,
        );
        this.progressBar.classList.remove('indeterminate');
        this.progressFill.style.width = `${(this.deepLoaded / this.deepTotal) * 100}%`;
      } else {
        this.setRun('Deep Read', SPECIALIST, 'Reaching the model library…', true);
        this.progressBar.classList.add('indeterminate');
        this.progressFill.style.width = '';
      }
      return;
    }

    if (this.queue.busy && this.currentPageId) {
      const page = this.pageMap.get(this.currentPageId);
      const doc = page && this.docs.find((d) => d.id === page.docId);
      this.progressBar.classList.remove('indeterminate');
      this.progressFill.style.width = `${total ? (done / total) * 100 : 0}%`;
      const where = page && doc ? `${doc.name} · page ${page.pageNo}` : '';
      if (this.currentMode === 'deep') {
        const secs = Math.max(0, Math.round((performance.now() - this.deepStartedAt) / 1000));
        this.setRun(
          'Deep Read',
          deepPhaseMessage(this.currentDeepPhase, this.currentDeepIndex, this.currentDeepTotal),
          [where, `${secs}s`, `${read} of ${total} read`].filter(Boolean).join(' · '),
          true,
        );
      } else {
        this.setRun(
          'Quick Read',
          this.ready ? stageMessage(this.currentStage, this.tick) : WARMING,
          [where, `${read} of ${total} read`].filter(Boolean).join(' · '),
          true,
        );
      }
    } else {
      this.setRun('', read > 0 && done === total ? CASE_CLOSED : 'All caught up.', `${read} of ${total} read`, false);
      this.progressBar.classList.remove('indeterminate');
      this.progressFill.style.width = `${total ? (done / total) * 100 : 0}%`;
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

const TILE_TITLE: Record<PageRecord['status'], string> = {
  queued: 'waiting',
  rasterizing: 'rendering…',
  processing: 'reading…',
  'needs-review': 'read — a look is suggested',
  done: 'read',
  error: 'couldn’t be read — click for details',
  cancelled: 'cancelled — click to retry',
};

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  if (label) b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

const ICON_DEEP = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.7 1.8L21.5 17.5l-1.8.7L19 20l-.7-1.8L16.5 17.5l1.8-.7z"/></svg>`;
const ICON_DOWNLOAD = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="m7 11 5 4 5-4"/><path d="M5 21h14"/></svg>`;
const ICON_TRASH = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 13h8l1-13"/></svg>`;
const ICON_CHEVRON_LEFT = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`;
