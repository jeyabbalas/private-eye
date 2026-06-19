/**
 * The review surface: the coordinator that turns one processed page into the full
 * review/correct experience — a zoomable scan beside the structured Markdown.
 *
 * Layout: a thin confidence filter spans both panes (verdict + sensitivity + a
 * worst-first stepper); below it the scan (zoom/pan, confidence overlay, region
 * draw) and the Markdown sit side by side and own the width. Review is inline:
 * each flagged spot is a highlight on the token plus a numbered book-tab in the
 * Markdown gutter, cross-lit with its scan region in both directions. Deep Read is
 * offered here, per page, for an exact-transcription result the heavier model might
 * resolve. The surface owns the page's transient resources and frees them on
 * destroy.
 */
import type { DocumentRecord, PageRecord } from '../orchestrate/types.ts';
import { pageImageBlob } from '../orchestrate/raster.ts';
import { markdownName, triggerDownload } from '../orchestrate/export.ts';
import { log } from '../runtime/logger.ts';
import { escapeHtml } from '../ui/progress.ts';
import type { QuickClient } from '../workers/client.ts';
import type { BBox } from '../core/types.ts';
import type { Block } from '../structure/blocks.ts';
import { ReviewSession, type ReviewState } from './session.ts';
import { createOverlay, type OverlayHandle } from './overlay.ts';
import { createScanView, type ScanViewHandle } from './scan-view.ts';
import { createThreshold, type ThresholdHandle } from './threshold.ts';
import { createEditor, type BlockAnnotation, type EditorHandle } from './markdown-editor.ts';
import { baseUid, blockToMarkdown } from './corrections.ts';
import { anchorUidFor, cropRegionToBlob } from './region-draw.ts';
import { buildAnnotations } from './annotate.ts';
import { verdictView } from './labels.ts';
import type { AttentionItem } from './attention.ts';
import { SAVED } from './copy.ts';

type DrawState = 'idle' | 'drawing' | 'busy';

export class ReviewSurface {
  readonly el: HTMLElement;

  private session: ReviewSession | null = null;
  private overlay: OverlayHandle | null = null;
  private scan: ScanViewHandle | null = null;
  private editor: EditorHandle | null = null;
  private threshold: ThresholdHandle | null = null;
  private unsub: (() => void) | null = null;

  private image: HTMLImageElement | null = null;
  private imgUrl: string | null = null;
  private attention: AttentionItem[] = [];
  private annByItem = new Map<string, BlockAnnotation>();
  private stepIdx = 0;
  private lastMarkdown: string | null = null;
  private destroyed = false;

  private undoBtn: HTMLButtonElement | null = null;
  private resetBtn: HTMLButtonElement | null = null;
  private drawBtn: HTMLButtonElement | null = null;
  private savedTag: HTMLElement | null = null;
  private savedTimer: number | null = null;
  private popClose: (() => void) | null = null;

  constructor(
    private readonly doc: DocumentRecord,
    private readonly page: PageRecord,
    private readonly quick: QuickClient,
    /** Opt this page into a Deep Read re-read (wired by the workspace). Null when
     *  unavailable (e.g. the page is already a Deep Read result). */
    private readonly onReadDeep: (() => void) | null = null,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'pe-review';
    this.el.innerHTML = '<div class="pe-boot"><span class="pe-spin"></span></div>';
  }

  /** Load the result + raster and build the surface. Safe to call once. */
  async load(): Promise<void> {
    const session = await ReviewSession.load(this.page.id);
    if (this.destroyed) {
      session?.destroy();
      return;
    }
    if (!session) {
      this.el.innerHTML = `<div class="pe-viewer-empty">${escapeHtml('This page hasn’t been read yet.')}</div>`;
      return;
    }
    this.session = session;

    let image: HTMLImageElement | null = null;
    try {
      const blob = await pageImageBlob(this.doc, this.page);
      if (this.destroyed) return;
      image = await this.loadImage(blob);
    } catch (e) {
      log.debug('overlay raster unavailable', e);
      image = null;
    }
    if (this.destroyed) return;
    this.image = image;

    this.build(session, image);
    this.unsub = session.subscribe((s) => this.apply(s));
    session.onAfterSave = () => this.flashSaved();
    this.apply(session.state());
  }

  destroy(): void {
    this.destroyed = true;
    this.closePopover();
    if (this.savedTimer != null) clearTimeout(this.savedTimer);
    this.unsub?.();
    this.unsub = null;
    this.scan?.destroy();
    this.scan = null;
    this.overlay?.destroy();
    this.overlay = null;
    this.session?.destroy(); // flushes any pending save
    this.session = null;
    if (this.imgUrl) {
      URL.revokeObjectURL(this.imgUrl);
      this.imgUrl = null;
    }
  }

  // ---------- build ----------

  private build(session: ReviewSession, image: HTMLImageElement | null): void {
    const init = session.state();

    this.threshold = createThreshold({
      tau: init.tau,
      onTau: (t) => session.setTau(t),
      onPrev: () => this.stepPrev(),
      onNext: () => this.stepNext(),
    });

    this.overlay = image
      ? createOverlay({
          image,
          width: session.width,
          height: session.height,
          layer: session.uncertainty,
          tau: init.tau,
          onHoverRegion: (bi) => this.onRegionHover(bi),
        })
      : null;
    this.scan =
      image && this.overlay
        ? createScanView({ content: this.overlay.el, pageWidth: session.width, pageHeight: session.height })
        : null;

    this.editor = createEditor({
      onEdit: (uid, md) => session.editBlock(uid, md),
      onRemove: (uid) => session.removeBlock(uid),
      onHover: (box) => this.overlay?.hover(box),
      onItemActivate: (id, anchor) => this.activateItem(id, anchor),
      onItemHover: (id) => this.onItemHover(id),
    });

    // Filter bar (spans both panes): verdict + sensitivity + stepper.
    const filterbar = document.createElement('div');
    filterbar.className = 'pe-filterbar';
    filterbar.append(this.buildVerdictChip(session), this.threshold.el);

    // Scan pane.
    const scanPane = document.createElement('section');
    scanPane.className = 'pe-pane pe-pane-scan';
    scanPane.append(this.buildScanHead());
    if (this.scan) scanPane.appendChild(this.scan.el);
    else {
      const empty = document.createElement('div');
      empty.className = 'pe-pane-empty';
      empty.textContent = 'Page image unavailable.';
      scanPane.appendChild(empty);
    }

    // Markdown pane.
    const mdPane = document.createElement('section');
    mdPane.className = 'pe-pane pe-pane-md';
    mdPane.append(this.buildMdHead(session), this.editor.el);

    const panes = document.createElement('div');
    panes.className = 'pe-panes';
    panes.append(scanPane, mdPane);

    this.el.replaceChildren(filterbar, panes);
  }

  private buildVerdictChip(session: ReviewSession): HTMLElement {
    const v = verdictView(session.verification, session.fellBack);
    const chip = document.createElement('div');
    chip.className = `pe-verdict-chip pe-tone-${v.tone}`;
    chip.setAttribute('role', 'status');
    chip.title = v.detail;
    chip.innerHTML = `<span class="pe-tone-dot" aria-hidden="true"></span><span class="pe-verdict-chip-text">${escapeHtml(v.title)}</span>`;
    return chip;
  }

  private buildScanHead(): HTMLElement {
    const head = document.createElement('div');
    head.className = 'pe-pane-head';

    const title = document.createElement('span');
    title.className = 'pe-pane-title';
    title.textContent = `${this.doc.name} · page ${this.page.pageNo}`;
    title.title = title.textContent;

    const tools = document.createElement('div');
    tools.className = 'pe-pane-tools';
    if (this.scan) {
      const zoom = document.createElement('div');
      zoom.className = 'pe-zoom';
      zoom.append(
        iconBtn('−', 'Zoom out', () => this.scan?.zoomBy(1 / 1.25)),
        iconBtn('Fit', 'Fit to width', () => this.scan?.fit()),
        iconBtn('100%', 'Actual size', () => this.scan?.actual()),
        iconBtn('+', 'Zoom in', () => this.scan?.zoomBy(1.25)),
      );
      tools.appendChild(zoom);
    }
    if (this.overlay) {
      this.drawBtn = iconBtn('Mark a missed area', 'Draw a box over text the read missed', () =>
        this.startRegionDraw(),
      );
      this.drawBtn.classList.add('pe-pane-btn');
      tools.appendChild(this.drawBtn);
    }

    head.append(title, tools);
    return head;
  }

  private buildMdHead(session: ReviewSession): HTMLElement {
    const head = document.createElement('div');
    head.className = 'pe-pane-head';

    const badge = document.createElement('span');
    badge.className = 'pe-readby';
    const readByText =
      session.pipeline === 'G'
        ? 'Read by Deep Read'
        : session.fellBack
          ? 'Deep Read → exact transcription'
          : 'Read by Quick Read';
    badge.innerHTML = `<span class="pe-readby-dot" aria-hidden="true"></span>${escapeHtml(readByText)}`;
    badge.title = readByText;

    const tools = document.createElement('div');
    tools.className = 'pe-pane-tools';

    // Deep Read escalation — the single way to invoke Deep Read, per page, offered
    // only for an exact-transcription result (Quick Read, or a Deep Read fallback).
    if (this.onReadDeep && session.pipeline === 'E') {
      const deep = iconBtn('Deep Read this page', 'Re-read this page with the heavier AI-assisted model', () =>
        this.onReadDeep?.(),
      );
      deep.classList.add('pe-pane-btn', 'pe-pane-btn-accent');
      tools.appendChild(deep);
    }

    const copy = iconBtn('Copy', 'Copy this page’s Markdown', () => {
      void navigator.clipboard?.writeText(session.markdown).then(() => this.flashStatus('Copied.'));
    });
    const download = iconBtn('Download', 'Download this page’s Markdown', () => {
      const name = `${markdownName(this.doc).replace(/\.md$/, '')}.p${this.page.pageNo}.md`;
      triggerDownload(new Blob([session.markdown], { type: 'text/markdown' }), name);
    });
    this.undoBtn = iconBtn('Undo', 'Undo the last change', () => session.undo());
    this.resetBtn = iconBtn('Revert all', 'Revert every change on this page', () => session.reset());
    this.undoBtn.disabled = true;
    this.resetBtn.disabled = true;
    copy.classList.add('pe-pane-btn');
    download.classList.add('pe-pane-btn');
    this.undoBtn.classList.add('pe-pane-btn');
    this.resetBtn.classList.add('pe-pane-btn');

    this.savedTag = document.createElement('span');
    this.savedTag.className = 'pe-saved-tag';
    this.savedTag.textContent = 'Edits save automatically';

    tools.append(copy, download, this.undoBtn, this.resetBtn, this.savedTag);
    head.append(badge, tools);
    return head;
  }

  // ---------- reactive apply ----------

  private apply(s: ReviewState): void {
    this.attention = s.attention;
    // Only re-render the editor when the document actually changed — never on a τ
    // drag — so an open inline editor isn't clobbered mid-edit.
    if (s.markdown !== this.lastMarkdown) {
      this.editor?.render(s.blocks);
      this.lastMarkdown = s.markdown;
    }
    const anns = buildAnnotations(s.attention, s.blocks);
    this.annByItem = new Map(anns.map((a) => [a.id, a]));
    this.editor?.setAnnotations(anns);
    this.threshold?.setCount(s.attention.length);
    this.threshold?.setStepEnabled(s.attention.length > 0);
    this.overlay?.setTau(s.tau);
    if (this.undoBtn) this.undoBtn.disabled = !s.edited;
    if (this.resetBtn) this.resetBtn.disabled = !s.edited;
  }

  // ---------- worklist navigation + cross-highlight ----------

  private stepNext(): void {
    if (!this.attention.length) return;
    const item = this.attention[this.stepIdx % this.attention.length]!;
    this.stepIdx = (this.stepIdx + 1) % this.attention.length;
    this.focusItem(item);
  }

  private stepPrev(): void {
    if (!this.attention.length) return;
    this.stepIdx = (this.stepIdx - 1 + this.attention.length) % this.attention.length;
    this.focusItem(this.attention[this.stepIdx]!);
  }

  private focusItem(item: AttentionItem): void {
    this.overlay?.focus(item.box);
    this.scan?.zoomToBox(item.box);
    this.editor?.highlightItem(item.id);
    const uid = this.annByItem.get(item.id)?.uid;
    if (uid) this.editor?.focusBlock(uid);
  }

  /** Hover a flagged spot in the Markdown → light its scan region (Markdown → scan). */
  private onItemHover(id: string | null): void {
    this.editor?.highlightItem(id);
    if (!id) {
      this.overlay?.hover(null);
      return;
    }
    const item = this.attention.find((it) => it.id === id);
    if (item) this.overlay?.hover(item.box);
  }

  /** Hover a region on the scan → light the matching Markdown block (scan → Markdown). */
  private onRegionHover(blockIndex: number | null): void {
    if (blockIndex == null) {
      this.editor?.highlightBlock(null);
      this.overlay?.hover(null);
      return;
    }
    const uid = baseUid(blockIndex);
    this.editor?.highlightBlock(uid);
    const box = this.session?.uncertainty?.blocks.find((b) => b.blockIndex === blockIndex)?.box;
    this.overlay?.hover(box ?? null);
  }

  // ---------- per-spot actions (popover) ----------

  private activateItem(id: string, anchor: HTMLElement): void {
    const item = this.attention.find((it) => it.id === id);
    if (!item) return;
    this.focusItem(item);
    this.openPopover(item, anchor);
  }

  private openPopover(item: AttentionItem, anchor: HTMLElement): void {
    this.closePopover();
    const pop = document.createElement('div');
    pop.className = 'pe-pop';

    const detail = document.createElement('div');
    detail.className = 'pe-pop-detail';
    detail.textContent = item.detail;
    pop.appendChild(detail);

    const actions = document.createElement('div');
    actions.className = 'pe-pop-actions';

    // For a cross-model conflict with an AI alternative, offer a one-click swap.
    if (item.conflict && item.conflict.vlmReading) {
      actions.appendChild(
        popBtn(`Use the AI’s “${item.conflict.vlmReading}”`, true, () => {
          this.useAiReading(item);
          this.closePopover();
        }),
      );
    }
    actions.appendChild(
      popBtn('Dismiss', false, () => {
        this.session?.dismiss(item.id);
        this.closePopover();
      }),
    );
    pop.appendChild(actions);

    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 6)}px`;
    pop.style.left = `${Math.round(Math.min(r.left, window.innerWidth - pop.offsetWidth - 12))}px`;

    const onDocClick = (e: MouseEvent): void => {
      if (!pop.contains(e.target as Node) && e.target !== anchor) this.closePopover();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') this.closePopover();
    };
    // Defer so the click that opened the popover doesn't immediately close it.
    setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    document.addEventListener('keydown', onKey);
    this.popClose = () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      pop.remove();
      this.popClose = null;
    };
  }

  private closePopover(): void {
    this.popClose?.();
  }

  /** Override a cross-model numeric conflict to the AI's reading. Under the 'replace'
   *  anchor policy the safe scan (OCR) reading is already in the block, so this swaps
   *  that applied value back to the VLM's — but only when the scan value appears
   *  exactly once and isn't embedded in a longer digit run, so we can't change the
   *  wrong occurrence; otherwise we open the block for a manual fix. */
  private useAiReading(item: AttentionItem): void {
    const ocr = item.conflict?.ocrReading;
    const vlm = item.conflict?.vlmReading;
    if (!this.session || ocr == null || vlm == null || item.blockIndex == null || item.blockIndex < 0) {
      this.focusItem(item);
      return;
    }
    const uid = baseUid(item.blockIndex);
    const block = this.session.state().blocks.find((b) => b.uid === uid);
    const md = block?.markdown ?? '';
    const at = md.indexOf(ocr);
    const before = at > 0 ? md[at - 1]! : '';
    const after = md[at + ocr.length] ?? '';
    const swappable = block != null && at >= 0 && at === md.lastIndexOf(ocr) && !/\d/.test(before) && !/\d/.test(after);
    if (swappable) {
      this.session.editBlock(uid, md.replace(ocr, vlm));
      this.session.dismiss(item.id); // resolved → out of the worklist
      this.flashStatus(`Used the AI’s “${vlm}”.`);
    } else {
      this.focusItem(item);
      this.flashStatus('Opened it for a closer look.');
    }
  }

  // ---------- region draw + on-demand OCR ----------

  private startRegionDraw(): void {
    if (!this.overlay || this.drawBtn?.disabled) return;
    this.setDrawState('drawing');
    this.overlay.beginDraw((box) => void this.onRegionDrawn(box));
  }

  private async onRegionDrawn(box: BBox | null): Promise<void> {
    if (!box || !this.session || !this.image) {
      this.setDrawState('idle');
      return;
    }
    this.setDrawState('busy');
    try {
      const blob = await cropRegionToBlob(this.image, box);
      const url = URL.createObjectURL(blob);
      let blocks: Block[];
      try {
        blocks = await this.quick.reocrRegion(url, box.x0, box.y0);
      } finally {
        URL.revokeObjectURL(url);
      }
      if (this.destroyed || !this.session) return;
      if (!blocks.length) {
        this.flashStatus('No text found in that area.');
        return;
      }
      // Splice the recovered blocks into reading order, chaining each after the
      // previous so multi-block regions keep their order.
      let after = anchorUidFor(this.session.state().blocks, box);
      for (const b of blocks) {
        const uid = `r${crypto.randomUUID()}`;
        this.session.addRegion({
          kind: 'region-add',
          uid,
          afterUid: after,
          blockKind: b.kind,
          markdown: blockToMarkdown(b),
          box: b.box,
        });
        after = uid;
      }
      this.flashStatus(`Added ${blocks.length} block${blocks.length > 1 ? 's' : ''}.`);
    } catch (e) {
      log.debug('region OCR failed', e);
      this.flashStatus('Couldn’t read that area.');
    } finally {
      if (!this.destroyed) this.setDrawState('idle');
    }
  }

  private setDrawState(state: DrawState): void {
    if (!this.drawBtn) return;
    this.drawBtn.classList.toggle('pe-btn-active', state === 'drawing');
    this.drawBtn.disabled = state !== 'idle';
    this.drawBtn.textContent =
      state === 'drawing' ? 'Draw a box — Esc to cancel' : state === 'busy' ? 'Reading the area…' : 'Mark a missed area';
  }

  // ---------- helpers ----------

  private flashSaved(): void {
    this.flashStatus(SAVED);
  }

  /** Briefly show a status message in the toolbar tag, then restore the hint. */
  private flashStatus(msg: string): void {
    if (this.destroyed || !this.savedTag) return;
    this.savedTag.textContent = msg;
    this.savedTag.classList.add('pe-saved-on');
    if (this.savedTimer != null) clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => {
      if (!this.savedTag) return;
      this.savedTag.classList.remove('pe-saved-on');
      this.savedTag.textContent = 'Edits save automatically';
    }, 1600);
  }

  private loadImage(blob: Blob): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      this.imgUrl = url;
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('page image failed to decode'));
      img.src = url;
    });
  }
}

function iconBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'pe-btn';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.addEventListener('click', onClick);
  return b;
}

function popBtn(label: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = `pe-att-btn${primary ? ' pe-att-btn-primary' : ''}`;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
