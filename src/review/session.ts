/**
 * The review session store: everything one page's review surface binds to. It
 * owns the base read (immutable), the reversible correction log, and the tunable
 * attention threshold τ, and is the single writer of the page's CorrectionRecord.
 *
 * The base read is the source of truth; edits are an event log replayed over it
 * (see corrections.ts), so every change is undoable and an unedited page round-
 * trips to byte-identical Markdown. τ is a *view* preference (what to highlight),
 * not a correction — changing it never writes. Saves are debounced and flushed on
 * destroy so rapid typing doesn't thrash IndexedDB.
 */
import type { Block } from '../structure/blocks.ts';
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import type { VerificationResult } from '../structure/verify.ts';
import type { DocId, PageId, ResultRecord } from '../orchestrate/types.ts';
import { getCorrection, getResult, putCorrection } from '../orchestrate/db.ts';
import {
  applyCorrections,
  baseHash,
  dismissedIds,
  renderWorkingMarkdown,
  type CorrectionEvent,
  type WorkingBlock,
} from './corrections.ts';
import { buildAttention, type AttentionItem } from './attention.ts';

export interface ReviewState {
  /** The working document (base read + replayed corrections). */
  blocks: WorkingBlock[];
  /** Markdown for the working document — the save/export artifact. */
  markdown: string;
  /** The current attention worklist (filtered by τ + dismissals). */
  attention: AttentionItem[];
  tau: number;
  /** Whether any corrections have been made (drives undo/reset affordances). */
  edited: boolean;
}

/** τ range for the highlight-sensitivity slider. Higher τ flags more (anything
 *  below the threshold); lower τ flags only the shakiest. The default sits at the
 *  low/worth-a-look band boundary (0.5): because a block's score is the MIN over
 *  its characters, a higher default would flag nearly every block on a clean
 *  scan. So the default worklist stays focused on genuinely uncertain regions
 *  (and the overlay shows red only); dragging right reveals the amber tier. */
export const TAU_MIN = 0.3;
export const TAU_MAX = 0.95;
export const TAU_DEFAULT = 0.5;

type Listener = (s: ReviewState) => void;

export class ReviewSession {
  readonly pageId: PageId;
  readonly docId: DocId;
  readonly pipeline: 'E' | 'G';
  readonly width: number;
  readonly height: number;
  readonly uncertainty: UncertaintyLayer | undefined;
  readonly verification: VerificationResult | undefined;
  readonly note: string | undefined;
  /** Flashed by the surface after each debounced save lands (for the "Saved." cue). */
  onAfterSave: (() => void) | null = null;

  private readonly baseBlocks: Block[];
  private readonly hash: string;
  private events: CorrectionEvent[];
  private tau = TAU_DEFAULT;
  private readonly listeners = new Set<Listener>();
  private saveTimer: number | null = null;

  private constructor(result: ResultRecord, correction?: { events?: unknown[]; baseHash?: string }) {
    this.pageId = result.pageId;
    this.docId = result.docId;
    this.pipeline = result.pipeline;
    this.width = result.width;
    this.height = result.height;
    this.uncertainty = result.uncertainty;
    this.verification = result.verification;
    this.note = result.note;
    this.baseBlocks = result.blocks ?? [];
    this.hash = baseHash(this.baseBlocks);
    // Replay a saved log only if it was recorded against THIS base read; a stale
    // log (page re-read since) would mis-target index-based uids, so we drop it.
    this.events =
      correction && correction.baseHash === this.hash && Array.isArray(correction.events)
        ? (correction.events as CorrectionEvent[])
        : [];
  }

  /** Load a page's result + any saved corrections. Null if it hasn't been read. */
  static async load(pageId: PageId): Promise<ReviewSession | null> {
    const result = await getResult(pageId);
    if (!result) return null;
    const correction = await getCorrection(pageId);
    return new ReviewSession(result, correction);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** True when there is a block model to edit (vs. a markdown-only legacy result). */
  get hasBlocks(): boolean {
    return this.baseBlocks.length > 0;
  }

  /** Current working Markdown (the copy/download/export artifact). */
  get markdown(): string {
    return renderWorkingMarkdown(applyCorrections(this.baseBlocks, this.events));
  }

  state(): ReviewState {
    const blocks = applyCorrections(this.baseBlocks, this.events);
    return {
      blocks,
      markdown: renderWorkingMarkdown(blocks),
      attention: buildAttention(this.uncertainty, this.verification, this.tau, dismissedIds(this.events)),
      tau: this.tau,
      edited: this.events.length > 0,
    };
  }

  // ---------- mutations ----------

  setTau(tau: number): void {
    const t = Math.min(TAU_MAX, Math.max(TAU_MIN, tau));
    if (t === this.tau) return;
    this.tau = t;
    this.emit(); // view-only: no save
  }

  editBlock(uid: string, markdown: string): void {
    this.push({ kind: 'text-edit', uid, markdown });
  }

  removeBlock(uid: string): void {
    this.push({ kind: 'block-remove', uid });
  }

  dismiss(targetId: string): void {
    this.push({ kind: 'dismiss', targetId });
  }

  addRegion(ev: Extract<CorrectionEvent, { kind: 'region-add' }>): void {
    this.push(ev);
  }

  undo(): void {
    if (!this.events.length) return;
    this.events = this.events.slice(0, -1);
    this.emit();
    this.scheduleSave();
  }

  reset(): void {
    if (!this.events.length) return;
    this.events = [];
    this.emit();
    this.scheduleSave();
  }

  private push(ev: CorrectionEvent): void {
    this.events = [...this.events, ev];
    this.emit();
    this.scheduleSave();
  }

  private emit(): void {
    const s = this.state();
    for (const fn of this.listeners) fn(s);
  }

  // ---------- persistence ----------

  private scheduleSave(): void {
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.save(), 350);
  }

  async save(): Promise<void> {
    if (this.saveTimer != null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await putCorrection({
      pageId: this.pageId,
      docId: this.docId,
      markdown: this.markdown,
      events: this.events,
      baseHash: this.hash,
      updatedAt: Date.now(),
    });
    this.onAfterSave?.();
  }

  /** Flush a pending save and drop listeners (called when the page is closed). */
  destroy(): void {
    const hadPending = this.saveTimer != null;
    this.listeners.clear();
    this.onAfterSave = null;
    if (hadPending) void this.save();
  }
}
