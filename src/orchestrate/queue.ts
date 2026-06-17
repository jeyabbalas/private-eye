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
import type { StageKey } from '../workers/protocol.ts';
import {
  getBlob,
  getDocument,
  getPage,
  putPage,
  putResult,
} from './db.ts';
import { rasterizePdfPage } from './pdf-raster.ts';
import { withObjectUrl, memText } from './memory.ts';
import { needsReview, type PageId, type PageRecord, type PageStatus } from './types.ts';
import { decodeError, reportError, type AppError } from '../runtime/errors.ts';
import { isDebug, log } from '../runtime/logger.ts';

export type QueueEvent =
  | { type: 'busy'; pageId: PageId }
  | { type: 'stage'; pageId: PageId; stage: StageKey }
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
  private readonly listeners = new Set<Listener>();
  private running = false;
  private currentPageId: PageId | null = null;

  constructor(quick: QuickClient) {
    this.quick = quick;
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

  /** Add pages (in order) and start draining if idle. Already-pending ids are skipped. */
  enqueue(pageIds: PageId[]): void {
    for (const id of pageIds) {
      this.discard.delete(id);
      this.removed.delete(id);
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
      void this.transition(pageId, { status: 'cancelled' });
    } else if (this.currentPageId === pageId) {
      this.discard.add(pageId);
    }
  }

  /** Drop everything: clear the queue and discard the in-flight page's result. */
  cancelAll(): void {
    const dropped = this.pending.splice(0);
    if (this.currentPageId) this.discard.add(this.currentPageId);
    for (const id of dropped) void this.transition(id, { status: 'cancelled' });
  }

  /** Remove pages from the queue without recording any status (used on doc delete).
   *  An in-flight page is flagged so its post-run write is suppressed — otherwise
   *  it would re-create the row the cascade delete just removed. */
  forget(pageIds: Iterable<PageId>): void {
    for (const id of pageIds) {
      const i = this.pending.indexOf(id);
      if (i >= 0) this.pending.splice(i, 1);
      if (this.currentPageId === id) this.removed.add(id);
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
        this.emit({ type: 'busy', pageId: next });
        await this.process(next);
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
      const result = await withObjectUrl(imageBlob, (url) =>
        this.quick.run(tag, url, (stage) => this.emit({ type: 'stage', pageId, stage })),
      );

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
        pipeline: 'E',
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
      const status: PageStatus = needsReview(result) ? 'needs-review' : 'done';
      await set({ status, width: result.width, height: result.height, renderScale, error: undefined });
    } catch (err) {
      if (this.removed.has(pageId)) {
        this.removed.delete(pageId);
        return;
      }
      if (this.discard.has(pageId)) {
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

  /** Status-only transition used by cancel paths (page may not be loaded). */
  private async transition(pageId: PageId, patch: Partial<PageRecord>): Promise<void> {
    const page = await getPage(pageId);
    if (!page) return;
    const next = { ...page, ...patch, updatedAt: Date.now() };
    await putPage(next);
    this.emit({ type: 'page', page: next });
  }
}
