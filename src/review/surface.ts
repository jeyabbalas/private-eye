/**
 * The review surface: the coordinator that turns one processed page into the
 * full review/correct experience. It loads the page's ReviewSession + raster,
 * assembles the verdict banner, confidence overlay, attention controls, worklist,
 * and the block-linked Markdown editor, and wires them together — hover a block
 * to light its region, step the worklist worst-first, edit a block and watch it
 * save. It owns the page's transient resources (image object URL, overlay,
 * session) and releases them on destroy.
 */
import type { DocumentRecord, PageRecord } from '../orchestrate/types.ts';
import { pageImageBlob } from '../orchestrate/raster.ts';
import { markdownName, triggerDownload } from '../orchestrate/export.ts';
import { log } from '../runtime/logger.ts';
import { escapeHtml } from '../ui/progress.ts';
import { ReviewSession, type ReviewState } from './session.ts';
import { createOverlay, type OverlayHandle } from './overlay.ts';
import { createVerdictBanner } from './verdict-banner.ts';
import { createThreshold, type ThresholdHandle } from './threshold.ts';
import { createAttentionPanel, type AttentionPanelHandle } from './attention-panel.ts';
import { createEditor, type EditorHandle } from './markdown-editor.ts';
import { baseUid } from './corrections.ts';
import type { AttentionItem } from './attention.ts';
import { SAVED } from './copy.ts';

export class ReviewSurface {
  readonly el: HTMLElement;

  private session: ReviewSession | null = null;
  private overlay: OverlayHandle | null = null;
  private editor: EditorHandle | null = null;
  private panel: AttentionPanelHandle | null = null;
  private threshold: ThresholdHandle | null = null;
  private unsub: (() => void) | null = null;

  private imgUrl: string | null = null;
  private attention: AttentionItem[] = [];
  private stepIdx = 0;
  private lastMarkdown: string | null = null;
  private destroyed = false;

  private undoBtn: HTMLButtonElement | null = null;
  private resetBtn: HTMLButtonElement | null = null;
  private savedTag: HTMLElement | null = null;
  private savedTimer: number | null = null;

  constructor(
    private readonly doc: DocumentRecord,
    private readonly page: PageRecord,
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

    this.build(session, image);
    this.unsub = session.subscribe((s) => this.apply(s));
    session.onAfterSave = () => this.flashSaved();
    this.apply(session.state());
  }

  destroy(): void {
    this.destroyed = true;
    if (this.savedTimer != null) clearTimeout(this.savedTimer);
    this.unsub?.();
    this.unsub = null;
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

    const head = document.createElement('div');
    head.className = 'pe-viewer-head';
    head.textContent = `${this.doc.name} · page ${this.page.pageNo}`;

    const banner = createVerdictBanner(session.verification, session.pipeline, false);

    this.threshold = createThreshold({
      tau: init.tau,
      onTau: (t) => session.setTau(t),
      onNext: () => this.stepNext(),
    });

    this.overlay = image
      ? createOverlay({
          image,
          width: session.width,
          height: session.height,
          layer: session.uncertainty,
          tau: init.tau,
        })
      : null;

    this.panel = createAttentionPanel({
      onShow: (item) => this.focusItem(item),
      onDismiss: (item) => session.dismiss(item.id),
    });

    this.editor = createEditor({
      onEdit: (uid, md) => session.editBlock(uid, md),
      onRemove: (uid) => session.removeBlock(uid),
      onHover: (box) => this.overlay?.hover(box),
    });

    const controls = document.createElement('div');
    controls.className = 'pe-review-controls';
    controls.append(this.threshold.el, this.buildToolbar(session));

    const left = document.createElement('div');
    left.className = 'pe-review-main';
    if (this.overlay) left.appendChild(this.overlay.el);
    else left.innerHTML = `<div class="pe-viewer-empty">${escapeHtml('Page image unavailable.')}</div>`;

    const right = document.createElement('div');
    right.className = 'pe-review-side';
    right.append(this.panel.el, this.editor.el);

    const grid = document.createElement('div');
    grid.className = 'pe-review-grid';
    grid.append(left, right);

    this.el.replaceChildren(head, banner, controls, grid);
  }

  private buildToolbar(session: ReviewSession): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'pe-review-toolbar';

    const copy = button('Copy Markdown', 'pe-btn', () => {
      void navigator.clipboard?.writeText(session.markdown).then(() => {
        const prev = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = prev), 1400);
      });
    });
    const download = button('Download page', 'pe-btn', () => {
      const name = `${markdownName(this.doc).replace(/\.md$/, '')}.p${this.page.pageNo}.md`;
      triggerDownload(new Blob([session.markdown], { type: 'text/markdown' }), name);
    });
    this.undoBtn = button('Undo', 'pe-btn', () => session.undo());
    this.resetBtn = button('Revert all', 'pe-btn', () => session.reset());
    this.undoBtn.disabled = true;
    this.resetBtn.disabled = true;

    this.savedTag = document.createElement('span');
    this.savedTag.className = 'pe-saved-tag';
    this.savedTag.textContent = 'Edits save automatically';

    bar.append(copy, download, this.undoBtn, this.resetBtn, this.savedTag);
    return bar;
  }

  // ---------- reactive apply ----------

  private apply(s: ReviewState): void {
    this.attention = s.attention;
    // Only re-render the editor when the document actually changed — never on a
    // τ drag — so an open inline editor isn't clobbered mid-edit.
    if (s.markdown !== this.lastMarkdown) {
      this.editor?.render(s.blocks);
      this.lastMarkdown = s.markdown;
    }
    this.panel?.render(s.attention);
    this.threshold?.setCount(s.attention.length);
    this.threshold?.setStepEnabled(s.attention.length > 0);
    this.overlay?.setTau(s.tau);
    if (this.undoBtn) this.undoBtn.disabled = !s.edited;
    if (this.resetBtn) this.resetBtn.disabled = !s.edited;
  }

  // ---------- worklist navigation ----------

  private stepNext(): void {
    if (!this.attention.length) return;
    const item = this.attention[this.stepIdx % this.attention.length]!;
    this.stepIdx = (this.stepIdx + 1) % this.attention.length;
    this.focusItem(item);
  }

  private focusItem(item: AttentionItem): void {
    this.overlay?.focus(item.box);
    if (item.blockIndex != null && item.blockIndex >= 0) this.editor?.focusBlock(baseUid(item.blockIndex));
  }

  // ---------- helpers ----------

  private flashSaved(): void {
    if (this.destroyed || !this.savedTag) return;
    this.savedTag.textContent = SAVED;
    this.savedTag.classList.add('pe-saved-on');
    if (this.savedTimer != null) clearTimeout(this.savedTimer);
    this.savedTimer = window.setTimeout(() => {
      if (!this.savedTag) return;
      this.savedTag.classList.remove('pe-saved-on');
      this.savedTag.textContent = 'Edits save automatically';
    }, 1400);
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

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
