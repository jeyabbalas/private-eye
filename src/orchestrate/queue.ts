/**
 * Processing queue — the single owner of the Quick Read worker and the enforcer
 * of the "one page at a time" invariant. It keeps the models resident across
 * pages (the worker is never re-spawned per page), processes exactly one page's
 * working set at a time, and frees that working set (the object URL) the instant
 * the page is done. It writes results + status transitions to IndexedDB and
 * emits events the UI mirrors.
 *
 * Cancellation: Quick Read's per-page read is short and cannot be interrupted
 * mid-flight without terminating the (warmed) worker, so cancel is cooperative —
 * queued pages are dropped immediately; a page already in flight finishes but its
 * result is discarded and the page marked `cancelled`. Deep Read (Phase 5) gets
 * true mid-decode cancellation via its abortable runner.
 */
import { QuickClient } from '../workers/client.ts';
import { DeepCancelled, type DeepClient } from '../workers/deep-client.ts';
import type { DeepPhaseKind, PageResult, StageKey } from '../workers/protocol.ts';
import {
  getBlob,
  getDocument,
  getPage,
  putPage,
  putResult,
} from './db.ts';
import { rasterizePdfPage } from './pdf-raster.ts';
import { withObjectUrl, memText } from './memory.ts';
import { type PageId, type PageRecord, type PageStatus, type ReadMode } from './types.ts';
import { reviewItemCount, TAU_DEFAULT } from '../review/attention.ts';
import { decodeError, reportError, type AppError } from '../runtime/errors.ts';
import { isDebug, log } from '../runtime/logger.ts';

export type QueueEvent =
  | { type: 'busy'; pageId: PageId; mode: ReadMode }
  | { type: 'stage'; pageId: PageId; stage: StageKey }
  /** Deep Read's richer progress (per-region "i of n"), mapped to copy by the UI. */
  | { type: 'deep-phase'; pageId: PageId; phase: DeepPhaseKind; index?: number; total?: number }
  | { type: 'page'; page: PageRecord }
  | { type: 'error'; pageId: PageId; error: AppError }
  | { type: 'idle' };

type Listener = (e: QueueEvent) => void;

export class ProcessingQueue {
  private readonly quick: QuickClient;
  private readonly pending: PageId[] = [];
  /** In-flight pages whose result should be dropped and marked `cancelled`. */
  private readonly discard = new Set<PageId>();
  /** In-flight pages whose row is being deleted — drop the result, write nothing. */
  private readonly removed = new Set<PageId>();
  /** Per-page read mode (set at enqueue time; cleared when the page finishes). */
  private readonly pageMode = new Map<PageId, ReadMode>();
  private readonly listeners = new Set<Listener>();
  private running = false;
  private currentPageId: PageId | null = null;
  private currentMode: ReadMode = 'quick';

  /** Resolves a ready Deep Read worker (consent + ~1.4 GB load happen here, in the
   *  workspace). Set by the workspace; absent until the user opts into Deep Read. */
  private deepProvider: (() => Promise<DeepClient>) | null = null;
  /** The resolved Deep Read client, kept so a cancel can abort its decode. */
  private deepClient: DeepClient | null = null;

  constructor(quick: QuickClient) {
    this.quick = quick;
  }

  /** Wire the Deep Read worker provider (the workspace owns its lifecycle). */
  setDeepProvider(fn: () => Promise<DeepClient>): void {
    this.deepProvider = fn;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get busy(): boolean {
    return this.running;
  }

  get pendingCount(): number {
    return this.pending.length + (this.currentPageId ? 1 : 0);
  }

  /** Add pages (in order) and start draining if idle. Already-pending ids are
   *  skipped. `mode` selects the pipeline; Deep Read pages assume the worker has
   *  already been readied by the workspace (it enqueues only after load). */
  enqueue(pageIds: PageId[], mode: ReadMode = 'quick'): void {
    for (const id of pageIds) {
      this.discard.delete(id);
      this.removed.delete(id);
      this.pageMode.set(id, mode);
      if (id !== this.currentPageId && !this.pending.includes(id)) this.pending.push(id);
    }
    void this.pump();
  }

  /** Drop a page: if it hasn't started, mark it cancelled now; if it's in flight,
   *  flag its result for discard. */
  cancelPage(pageId: PageId): void {
    const i = this.pending.indexOf(pageId);
    if (i >= 0) {
      this.pending.splice(i, 1);
      this.pageMode.delete(pageId);
      void this.transition(pageId, { status: 'cancelled' });
    } else if (this.currentPageId === pageId) {
      this.discard.add(pageId);
      this.abortCurrentDeep();
    }
  }

  /** Drop everything: clear the queue and discard the in-flight page's result. */
  cancelAll(): void {
    const dropped = this.pending.splice(0);
    if (this.currentPageId) {
      this.discard.add(this.currentPageId);
      this.abortCurrentDeep();
    }
    for (const id of dropped) {
      this.pageMode.delete(id);
      void this.transition(id, { status: 'cancelled' });
    }
  }

  /** Truly interrupt the in-flight Deep Read decode (Quick Read can't be cut mid
   *  page — it just gets discarded on completion). No-op for Quick pages. */
  private abortCurrentDeep(): void {
    if (this.currentMode === 'deep') this.deepClient?.cancelCurrent();
  }

  /** Remove pages from the queue without recording any status (used on doc delete).
   *  An in-flight page is flagged so its post-run write is suppressed — otherwise
   *  it would re-create the row the cascade delete just removed. */
  forget(pageIds: Iterable<PageId>): void {
    for (const id of pageIds) {
      const i = this.pending.indexOf(id);
      if (i >= 0) this.pending.splice(i, 1);
      this.pageMode.delete(id);
      if (this.currentPageId === id) {
        this.removed.add(id);
        this.abortCurrentDeep();
      }
    }
  }

  private emit(e: QueueEvent): void {
    for (const l of this.listeners) l(e);
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let next: PageId | undefined;
      while ((next = this.pending.shift())) {
        this.currentPageId = next;
        this.currentMode = this.pageMode.get(next) ?? 'quick';
        this.emit({ type: 'busy', pageId: next, mode: this.currentMode });
        await this.process(next);
        this.pageMode.delete(next);
        this.currentPageId = null;
        if (isDebug()) log.debug('page done ·', memText());
      }
    } finally {
      this.running = false;
      this.emit({ type: 'idle' });
    }
  }

  private async process(pageId: PageId): Promise<void> {
    let page = await getPage(pageId);
    if (!page || this.removed.has(pageId)) {
      this.removed.delete(pageId);
      return;
    }
    if (page.status === 'cancelled' || this.discard.has(pageId)) {
      this.discard.delete(pageId);
      return;
    }
    const doc = await getDocument(page.docId);
    if (!doc) return;

    const set = async (patch: Partial<PageRecord>): Promise<void> => {
      page = { ...page!, ...patch, updatedAt: Date.now() };
      await putPage(page);
      this.emit({ type: 'page', page });
    };

    try {
      const src = await getBlob(doc.blobKey);
      if (!src) throw decodeError('source file is missing from storage', { blobKey: doc.blobKey });

      // Rasterize PDF pages on demand; images are read directly.
      let imageBlob: Blob;
      let renderScale: number | undefined;
      if (doc.kind === 'pdf') {
        await set({ status: 'rasterizing' });
        const r = await rasterizePdfPage(src, page.pageNo);
        imageBlob = r.blob;
        renderScale = r.scale;
      } else {
        imageBlob = src;
      }

      await set({ status: 'processing' });
      const tag = `${doc.name.replace(/\.[^.]+$/, '')}.${page.pageNo}`;
      const result = await this.readPage(pageId, tag, imageBlob, this.pageMode.get(pageId) ?? 'quick');

      if (this.removed.has(pageId)) {
        this.removed.delete(pageId);
        return;
      }
      if (this.discard.has(pageId)) {
        this.discard.delete(pageId);
        await set({ status: 'cancelled' });
        return;
      }

      await putResult({
        pageId,
        docId: doc.id,
        pipeline: result.pipeline,
        fellBack: result.fellBack,
        markdown: result.markdown,
        uncertainty: result.uncertainty,
        verification: result.verification,
        blocks: result.blocks,
        note: result.note,
        totalMs: result.totalMs,
        stageMs: result.stageMs,
        width: result.width,
        height: result.height,
        createdAt: Date.now(),
      });
      // Initial status mirrors the live worklist at the default threshold (no
      // dismissals yet); the review surface keeps it in sync from here on.
      const status: PageStatus =
        reviewItemCount(result.uncertainty, result.verification, TAU_DEFAULT) > 0 ? 'needs-review' : 'done';
      await set({ status, width: result.width, height: result.height, renderScale, error: undefined });
    } catch (err) {
      if (this.removed.has(pageId)) {
        this.removed.delete(pageId);
        return;
      }
      // A Deep Read cancel (Stop / unload) surfaces here — it's not an error.
      if (err instanceof DeepCancelled || this.discard.has(pageId)) {
        this.discard.delete(pageId);
        await set({ status: 'cancelled' });
        return;
      }
      const appError = reportError(err, { context: 'queue:process' });
      log.error(`page ${pageId} failed: ${appError.technical}`);
      await set({ status: 'error', error: appError.userMessage });
      this.emit({ type: 'error', pageId, error: appError });
    }
  }

  /** Run one page through the chosen pipeline, normalizing to a result that
   *  carries which pipeline actually produced it (Deep Read may fall back to E). */
  private async readPage(
    pageId: PageId,
    tag: string,
    imageBlob: Blob,
    mode: ReadMode,
  ): Promise<PageResult & { pipeline: 'E' | 'G'; fellBack: boolean }> {
    if (mode === 'deep') {
      if (!this.deepProvider) throw new Error('Deep Read is not available');
      const deep = await this.deepProvider(); // resolves an already-loaded worker
      this.deepClient = deep;
      return withObjectUrl(imageBlob, (url) =>
        deep.run(tag, url, {
          onPhase: (phase, index, total) => this.emit({ type: 'deep-phase', pageId, phase, index, total }),
        }),
      );
    }
    const result = await withObjectUrl(imageBlob, (url) =>
      this.quick.run(tag, url, (stage) => this.emit({ type: 'stage', pageId, stage })),
    );
    return { ...result, pipeline: 'E', fellBack: false };
  }

  /** Status-only transition used by cancel paths (page may not be loaded). */
  private async transition(pageId: PageId, patch: Partial<PageRecord>): Promise<void> {
    const page = await getPage(pageId);
    if (!page) return;
    const next = { ...page, ...patch, updatedAt: Date.now() };
    await putPage(next);
    this.emit({ type: 'page', page: next });
  }
}
