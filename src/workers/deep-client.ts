/**
 * Deep Read client — runs on the MAIN THREAD.
 *
 * Why not a Web Worker (like Quick Read)? Because the proven prototype loads + reads
 * wllama on the MAIN thread, and we match that configuration. (Earlier worker-side
 * experiments hit OPFS QuotaExceededErrors around ~1 GB; that was an incognito-window
 * quota artifact — a normal window has the full quota — not a real worker limit, but
 * there's no reason to move off the prototype's proven main-thread path.)
 *
 * This is not the jank it sounds like: wllama performs its heavy inference in its
 * OWN nested workers, so the main-thread event loop only orchestrates. The one
 * piece of main-thread compute is the deterministic layout/OCR prefix — a brief
 * blip per page. Quick Read stays fully off-thread in its own worker, untouched.
 *
 * Memory is reclaimed by tearing wllama down (unloadG → wllama.exit) plus the
 * deterministic engine caches (releaseG, disposeE) — the main-thread equivalent
 * of the old worker.terminate().
 *
 * Public surface is identical to the old worker-backed client, so the workspace
 * UI and the processing queue are unchanged: load() / run() / cancelCurrent() /
 * terminate(), with the same DeepLoadHandlers / DeepRunHooks / DeepResult.
 *
 * PRIVACY: the only network traffic is the inbound GET for the public model
 * weights (HuggingFace CDN). No document bytes ever leave the device.
 */
import { reportError, type AppError } from '../runtime/errors.ts';
import { log, setDebug } from '../runtime/logger.ts';
import { disposeE } from '../runtime/run-e.ts';
import { runDocument } from '../runtime/run-doc.ts';
import { CancelledError, gEpNote, gVlmNote, loadG, releaseG, unloadG, type AppEp, type GProgress } from '../runtime/run-g-live.ts';
import type { DeepPhaseKind, DeepResult } from './protocol.ts';

/** Rejection reason when a Deep Read run is cancelled by the user (vs. an error). */
export class DeepCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'DeepCancelled';
  }
}

export interface DeepLoadHandlers {
  onLoadProgress?(loaded: number, total: number): void;
}

export interface DeepRunHooks {
  onPhase?(phase: DeepPhaseKind, index?: number, total?: number): void;
}

export interface DeepClientHandlers {
  /** Errors not tied to a specific job (rare; load/run reject with their own). */
  onError?(err: AppError): void;
}

/** Map the runner's (jargon-bearing) status strings to a coarse, plain phase the
 *  main thread renders detective copy for — never surface the raw string. */
function phaseOf(s: string): DeepPhaseKind {
  if (s.includes('fallback') || s.includes('Pipeline E')) return 'fallback';
  if (s.includes('assembling') || s.includes('anchoring')) return 'verifying';
  if (s.includes('deterministic') || s.includes('layout') || s.includes('engines')) return 'preparing';
  return 'examining';
}

export class DeepClient {
  private readonly onnxEp: AppEp;
  private readonly vlmEp: AppEp;
  private readonly handlers: DeepClientHandlers;
  /** The in-flight load, so repeated load() calls share it (idempotent). */
  private loadPromise: Promise<string> | null = null;
  /** The single in-flight run, so cancelCurrent() can abort its decode. */
  private current: AbortController | null = null;
  loaded = false;

  constructor(opts: { debug: boolean; onnxEp: AppEp; vlmEp: AppEp; handlers?: DeepClientHandlers }) {
    this.onnxEp = opts.onnxEp;
    this.vlmEp = opts.vlmEp;
    this.handlers = opts.handlers ?? {};
    setDebug(opts.debug);
    log.debug(`deep client ready · main-thread build · vlmEp=${this.vlmEp}`);
  }

  /** Download + load the VLM. Resolves with an EP note when ready to read pages.
   *  `onLoadProgress` streams the one-time download bytes. */
  load(handlers?: DeepLoadHandlers): Promise<string> {
    if (this.loadPromise) return this.loadPromise;
    const p: GProgress = {
      onStatus: (s) => log.debug('[deep:load]', s),
      onLoadProgress: (loaded, total) => handlers?.onLoadProgress?.(loaded, total),
    };
    this.loadPromise = loadG(p, this.vlmEp).then(
      () => {
        this.loaded = true;
        return `${gEpNote()} · ${gVlmNote()}`;
      },
      (err) => {
        this.loadPromise = null; // a failed load may retry on a fresh attempt
        throw reportError(err, { context: 'deep-main:load', executionProviders: { onnxEp: this.onnxEp, vlmEp: this.vlmEp } });
      },
    );
    return this.loadPromise;
  }

  /** Read one page with Deep Read. Rejects with DeepCancelled if cancelled. */
  async run(tag: string, imageUrl: string, hooks?: DeepRunHooks): Promise<DeepResult> {
    const ac = new AbortController();
    this.current = ac;
    const t0 = performance.now();
    const p: GProgress = {
      onStatus: (s) => hooks?.onPhase?.(phaseOf(s)),
      onRegionStart: (i, n) => hooks?.onPhase?.('cross-examining', i, n),
    };
    try {
      const routed = await runDocument(tag, imageUrl, p, { onnxEp: this.onnxEp, vlmEp: this.vlmEp, cancel: ac.signal });
      hooks?.onPhase?.('finishing');
      return {
        markdown: routed.markdown,
        uncertainty: routed.uncertainty,
        verification: routed.verification,
        blocks: routed.blocks,
        note: routed.note,
        stageMs: {},
        totalMs: Math.round(performance.now() - t0),
        width: routed.uncertainty?.width ?? 0,
        height: routed.uncertainty?.height ?? 0,
        pipeline: routed.pipeline,
        fellBack: routed.fallbackFrom != null,
      };
    } catch (err) {
      if (err instanceof CancelledError) throw new DeepCancelled();
      throw reportError(err, { context: 'deep-main:run', executionProviders: { onnxEp: this.onnxEp, vlmEp: this.vlmEp } });
    } finally {
      if (this.current === ac) this.current = null;
    }
  }

  /** Abort the in-flight read (the run promise rejects with DeepCancelled). */
  cancelCurrent(): void {
    this.current?.abort();
  }

  get busy(): boolean {
    return this.current != null;
  }

  /** Reclaim the ~1.4 GB VLM + deterministic engines — the main-thread equivalent
   *  of worker.terminate(). Fire-and-forget async teardown; the caller discards us. */
  terminate(): void {
    this.current?.abort();
    this.current = null;
    this.loadPromise = null;
    this.loaded = false;
    void unloadG().catch(() => {}); // wllama.exit()
    releaseG(); // deterministic-stage engine caches
    void disposeE().catch(() => {}); // E fallback pipeline, if it was loaded
  }
}
