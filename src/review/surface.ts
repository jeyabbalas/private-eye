/**
 * The review surface: the coordinator that turns one processed page into the full
 * review/correct experience — a zoomable scan beside the structured Markdown.
 *
 * Layout: a thin confidence filter spans both panes (verdict + flags chip + a
 * worst-first stepper); below it the scan (zoom/pan, confidence overlay, region
 * draw) and the Markdown sit side by side with a draggable divider between them.
 * Review is inline: each flagged spot is a highlight on the token plus a numbered
 * book-tab in the Markdown gutter, cross-lit with its scan region in both
 * directions. The scan head hosts an in-pane pager (read pages only, also on
 * `[` / `]`); one keydown router on the surface drives pan/zoom/page/undo keys.
 * Deep Read is offered here, per page, for an exact-transcription result the
 * heavier model might resolve. The surface owns the page's transient resources
 * and frees them on destroy.
 */
import type { DocumentRecord, PageRecord } from '../orchestrate/types.ts';
import { pageImageBlob } from '../orchestrate/raster.ts';
import { markdownName, triggerDownload } from '../orchestrate/export.ts';
import { log } from '../runtime/logger.ts';
import { escapeHtml } from '../ui/progress.ts';
import { showModal } from '../ui/modal.ts';
import { openMenu } from '../ui/menu.ts';
import {
  ICON_CHEVRON_LEFT,
  ICON_CHEVRON_RIGHT,
  ICON_COPY,
  ICON_DOWNLOAD,
  ICON_ELLIPSIS,
  ICON_MARK,
} from '../ui/icons.ts';
import type { QuickClient } from '../workers/client.ts';
import type { BBox } from '../core/types.ts';
import type { Block } from '../structure/blocks.ts';
import { ReviewSession, type ReviewState } from './session.ts';
import { createOverlay, type OverlayHandle } from './overlay.ts';
import { createScanView, type ScanViewHandle } from './scan-view.ts';
import { createThreshold, type ThresholdHandle } from './threshold.ts';
import { createEditor, type BlockAnnotation, type EditorHandle } from './markdown-editor.ts';
import { initSplit, type SplitHandle } from './split.ts';
import { isEditableTarget, reviewKeyAction } from './keys.ts';
import { baseUid, blockToMarkdown } from './corrections.ts';
import { anchorUidFor, cropRegionToBlob } from './region-draw.ts';
import { buildAnnotations } from './annotate.ts';
import { verdictView } from './labels.ts';
import type { AttentionItem } from './attention.ts';
import { SAVED } from './copy.ts';

type DrawState = 'idle' | 'drawing' | 'busy';

export interface PageNav {
  pageNo: number;
  pageCount: number;
  /** Step to the previous/next *read* page of this document. */
  onNav: (dir: 1 | -1) => void;
}

export class ReviewSurface {
  readonly el: HTMLElement;

  private session: ReviewSession | null = null;
  private overlay: OverlayHandle | null = null;
  private scan: ScanViewHandle | null = null;
  private editor: EditorHandle | null = null;
  private threshold: ThresholdHandle | null = null;
  private split: SplitHandle | null = null;
  private unsub: (() => void) | null = null;

  private image: HTMLImageElement | null = null;
  private imgUrl: string | null = null;
  private attention: AttentionItem[] = [];
  private annByItem = new Map<string, BlockAnnotation>();
  private stepIdx = 0;
  private lastMarkdown: string | null = null;
  /** Last reported needs-review state, so we only notify the workspace on a flip. */
  private lastNeedsReview: boolean | null = null;
  private destroyed = false;

  private drawState: DrawState = 'idle';
  private drawBtn: HTMLButtonElement | null = null;
  private mdPane: HTMLElement | null = null;
  private flashEl: HTMLElement | null = null;
  private flashTimer: number | null = null;
  private zoomLabel: HTMLButtonElement | null = null;
  private zoomFit = true;
  private pagerPrev: HTMLButtonElement | null = null;
  private pagerNext: HTMLButtonElement | null = null;
  private navPrevOk = false;
  private navNextOk = false;
  private popClose: (() => void) | null = null;

  constructor(
    private readonly doc: DocumentRecord,
    private readonly page: PageRecord,
    private readonly quick: QuickClient,
    /** Opt this page into a Deep Read re-read (wired by the workspace). Null when
     *  unavailable (e.g. the page is already a Deep Read result). */
    private readonly onReadDeep: (() => void) | null = null,
    /** Report this page's live needs-review state back to the workspace so the
     *  rail tile + persisted status track the reviewer's activity and the τ
     *  slider. Fires only when the boolean changes. */
    private readonly onReview: ((needsReview: boolean) => void) | null = null,
    /** In-pane page navigation across this document's read pages (the scan-head
     *  pager and the `[` / `]` keys). Null for single-page documents. */
    private readonly pageNav: PageNav | null = null,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'pe-review';
    // Programmatic focus target so `[` / `]` keep working across page hops even
    // before the async build lands (the rebuild otherwise drops focus to <body>).
    this.el.tabIndex = -1;
    this.el.addEventListener('keydown', this.onKeys);
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
    if (this.flashTimer != null) clearTimeout(this.flashTimer);
    this.el.removeEventListener('keydown', this.onKeys);
    this.unsub?.();
    this.unsub = null;
    this.split?.destroy();
    this.split = null;
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

  /** Update the pager's reach (wired by the workspace as sibling pages finish). */
  setPageNav(canPrev: boolean, canNext: boolean): void {
    this.navPrevOk = canPrev;
    this.navNextOk = canNext;
    if (this.pagerPrev) this.pagerPrev.disabled = !canPrev;
    if (this.pagerNext) this.pagerNext.disabled = !canNext;
  }

  /** Hand keyboard focus to the scan viewport (or the surface until it builds). */
  focusScan(): void {
    (this.scan?.el ?? this.el).focus();
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
        ? createScanView({
            content: this.overlay.el,
            pageWidth: session.width,
            pageHeight: session.height,
            onTransform: (scale, fit) => this.onScanTransform(scale, fit),
          })
        : null;

    this.editor = createEditor({
      onEdit: (uid, md) => session.editBlock(uid, md),
      onRemove: (uid) => session.removeBlock(uid),
      onHover: (box) => this.overlay?.hover(box),
      onItemActivate: (id, anchor) => this.activateItem(id, anchor),
      onItemHover: (id) => this.onItemHover(id),
    });

    // Filter bar (spans both panes): verdict + flags chip + stepper.
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
    this.mdPane = mdPane;

    const panes = document.createElement('div');
    panes.className = 'pe-panes';
    panes.append(scanPane, mdPane);
    this.split = initSplit(panes, scanPane, { storageKey: 'pe.review.split', minPx: 300 });

    this.el.replaceChildren(filterbar, panes);
    this.setPageNav(this.navPrevOk, this.navNextOk);
    // If focus was parked on the surface (a pager hop mid-build), upgrade it to
    // the scan viewport so the pan/zoom keys work immediately.
    if (document.activeElement === this.el && this.scan) this.scan.el.focus();
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

  /** Scan-pane head: `‹ page 3 / 12 ›` pager (read pages only; hidden for 1-page
   *  docs) · zoom cluster with a live Fit/percent label · region-draw icon. */
  private buildScanHead(): HTMLElement {
    const head = document.createElement('div');
    head.className = 'pe-pane-head';

    if (this.pageNav && this.pageNav.pageCount > 1) {
      const pager = document.createElement('div');
      pager.className = 'pe-pager';
      this.pagerPrev = svgBtn(ICON_CHEVRON_LEFT, 'Previous read page ( [ )', () => {
        if (this.navPrevOk) this.pageNav?.onNav(-1);
      });
      this.pagerNext = svgBtn(ICON_CHEVRON_RIGHT, 'Next read page ( ] )', () => {
        if (this.navNextOk) this.pageNav?.onNav(1);
      });
      const label = document.createElement('span');
      label.className = 'pe-pager-label';
      label.textContent = `page ${this.pageNav.pageNo} / ${this.pageNav.pageCount}`;
      label.title = this.doc.name;
      pager.append(this.pagerPrev, label, this.pagerNext);
      head.appendChild(pager);
    }

    const tools = document.createElement('div');
    tools.className = 'pe-pane-tools';
    if (this.scan) {
      const zoom = document.createElement('div');
      zoom.className = 'pe-zoom';
      this.zoomLabel = iconBtn('Fit', 'Toggle fit ↔ 100% ( 0 / 1 )', () => {
        if (this.zoomFit) this.scan?.actual();
        else this.scan?.fit();
      });
      this.zoomLabel.classList.add('pe-zoom-label');
      zoom.append(
        iconBtn('−', 'Zoom out ( − )', () => this.scan?.zoomBy(1 / 1.25)),
        this.zoomLabel,
        iconBtn('+', 'Zoom in ( + )', () => this.scan?.zoomBy(1.25)),
      );
      tools.appendChild(zoom);
    }
    if (this.overlay) {
      this.drawBtn = svgBtn(ICON_MARK, 'Mark a missed area — draw a box over text the read missed', () =>
        this.startRegionDraw(),
      );
      tools.appendChild(this.drawBtn);
    }

    head.appendChild(tools);
    return head;
  }

  /** Markdown-pane head: read-by badge · Deep Read CTA · copy/download icons ·
   *  an overflow menu holding undo / revert-all / the autosave note. */
  private buildMdHead(session: ReviewSession): HTMLElement {
    const head = document.createElement('div');
    head.className = 'pe-pane-head';

    const badge = document.createElement('span');
    badge.className = 'pe-readby';
    const readByFull =
      session.pipeline === 'G'
        ? 'Read by Deep Read'
        : session.fellBack
          ? 'Deep Read fell back to the exact transcription'
          : 'Read by Quick Read';
    const readByShort =
      session.pipeline === 'G' ? 'Deep Read' : session.fellBack ? 'Deep Read → exact' : 'Quick Read';
    badge.innerHTML = `<span class="pe-readby-dot" aria-hidden="true"></span>${escapeHtml(readByShort)}`;
    badge.title = readByFull;

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

    const copy = svgBtn(ICON_COPY, 'Copy this page’s Markdown', () => {
      void navigator.clipboard?.writeText(session.markdown).then(() => this.flashStatus('Copied.'));
    });
    const download = svgBtn(ICON_DOWNLOAD, 'Download this page’s Markdown', () => {
      const name = `${markdownName(this.doc).replace(/\.md$/, '')}.p${this.page.pageNo}.md`;
      triggerDownload(new Blob([session.markdown], { type: 'text/markdown' }), name);
    });
    const more = svgBtn(ICON_ELLIPSIS, 'More actions', () => {
      const edited = session.state().edited; // live at open, so states are honest
      openMenu(more, [
        { label: 'Undo last change', disabled: !edited, onSelect: () => session.undo() },
        { label: 'Revert all changes…', danger: true, disabled: !edited, onSelect: () => this.confirmRevert(session) },
        { separator: true },
        { note: 'Edits save automatically' },
      ]);
    });
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-expanded', 'false');

    tools.append(copy, download, more);
    head.append(badge, tools);
    return head;
  }

  private confirmRevert(session: ReviewSession): void {
    showModal({
      title: 'Revert all changes?',
      body: 'This removes every correction made on this page and restores the original reading. It cannot be undone.',
      actions: [
        { label: 'Revert all', primary: true, onClick: () => session.reset() },
        { label: 'Cancel' },
      ],
    });
  }

  // ---------- keyboard ----------

  private readonly onKeys = (e: KeyboardEvent): void => {
    const action = reviewKeyAction(
      e.key,
      { shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey },
      {
        inEditable: isEditableTarget(e.target),
        drawing: this.drawState === 'busy' || this.rubberBandLive(),
        scanFocused: this.scan != null && e.target === this.scan.el,
      },
    );
    if (!action) return;
    e.preventDefault();
    switch (action.kind) {
      case 'pan':
        this.scan?.panBy(action.dx, action.dy);
        break;
      case 'pan-page':
        if (this.scan) this.scan.panBy(0, action.dir * Math.max(80, Math.round(this.scan.el.clientHeight * 0.85)));
        break;
      case 'pan-edge':
        this.scan?.panEdge(action.edge);
        break;
      case 'zoom':
        this.scan?.zoomBy(action.factor);
        break;
      case 'fit':
        this.scan?.fit();
        break;
      case 'actual':
        this.scan?.actual();
        break;
      case 'page':
        if (action.dir === -1 ? this.navPrevOk : this.navNextOk) this.pageNav?.onNav(action.dir);
        break;
      case 'undo':
        this.session?.undo();
        break;
    }
  };

  /** True while a region-draw rubber band is actively being dragged. */
  private rubberBandLive(): boolean {
    const rect = this.el.querySelector<HTMLElement>('.pe-draw-rect');
    return !!rect && rect.style.display !== 'none';
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
    // Keep the rail indicator in sync: red iff the worklist is non-empty.
    const needs = s.attention.length > 0;
    if (needs !== this.lastNeedsReview) {
      this.lastNeedsReview = needs;
      this.onReview?.(needs);
    }
    this.overlay?.setTau(s.tau);
  }

  /** Keep the zoom label honest: "Fit" at the fit scale, else a live percent. */
  private onScanTransform(scale: number, fitScale: number): void {
    this.zoomFit = Math.abs(scale - fitScale) < 0.005;
    if (this.zoomLabel) this.zoomLabel.textContent = this.zoomFit ? 'Fit' : `${Math.round(scale * 100)}%`;
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
    if (!this.overlay || this.drawState !== 'idle') return;
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

  /** Reflect the draw lifecycle on the icon button and the floating viewport
   *  hint chip (armed: instructions; busy: progress) — never via button text. */
  private setDrawState(state: DrawState): void {
    this.drawState = state;
    if (this.drawBtn) {
      this.drawBtn.classList.toggle('pe-btn-active', state === 'drawing');
      this.drawBtn.classList.toggle('pe-btn-busy', state === 'busy');
      this.drawBtn.disabled = state !== 'idle';
    }
    const host = this.scan?.el;
    if (!host) return;
    let hint = host.querySelector<HTMLElement>('.pe-scanhint');
    if (state === 'idle') {
      hint?.remove();
      return;
    }
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'pe-scanhint';
      host.appendChild(hint);
    }
    hint.textContent = state === 'drawing' ? 'Drag a box over the missed text — Esc cancels' : 'Reading the area…';
  }

  // ---------- helpers ----------

  private flashSaved(): void {
    this.flashStatus(SAVED);
  }

  /** Briefly float a status chip at the Markdown pane's top-right, then fade. */
  private flashStatus(msg: string): void {
    if (this.destroyed || !this.mdPane) return;
    if (!this.flashEl) {
      this.flashEl = document.createElement('div');
      this.flashEl.className = 'pe-pane-flash';
      this.flashEl.setAttribute('role', 'status');
      this.mdPane.appendChild(this.flashEl);
    }
    this.flashEl.textContent = msg;
    this.flashEl.classList.add('pe-pane-flash-on');
    if (this.flashTimer != null) clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      this.flashEl?.classList.remove('pe-pane-flash-on');
      this.flashTimer = null;
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

function svgBtn(icon: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'pe-iconbtn';
  b.innerHTML = icon;
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
