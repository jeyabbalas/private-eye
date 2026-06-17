/**
 * Main-thread client wrapping the Quick Read worker in a Promise/event API, so
 * the rest of the app never touches postMessage directly.
 */
import type { AppError } from '../runtime/errors.ts';
import type { AppEp } from '../runtime/run-e.ts';
import type { FromQuickWorker, PageResult, StageKey, ToQuickWorker } from './protocol.ts';

export interface QuickClientHandlers {
  onLoadProgress?(loaded: number, total: number): void;
  onReady?(epNote: string): void;
  /** Errors not tied to a specific job (e.g. warm-up failure). */
  onError?(err: AppError): void;
}

interface Job {
  resolve(r: PageResult): void;
  reject(e: AppError): void;
  onStage?(stage: StageKey, raw: string): void;
}

export class QuickClient {
  private readonly worker: Worker;
  private nextJob = 1;
  private readonly jobs = new Map<number, Job>();
  private readonly handlers: QuickClientHandlers;
  warmed = false;

  constructor(opts: { debug: boolean; onnxEp: AppEp; handlers?: QuickClientHandlers }) {
    this.handlers = opts.handlers ?? {};
    this.worker = new Worker(new URL('./quick.worker.ts', import.meta.url), { type: 'module', name: 'quick-read' });
    this.worker.onmessage = (e: MessageEvent<FromQuickWorker>) => this.handle(e.data);
    this.send({ type: 'init', debug: opts.debug, onnxEp: opts.onnxEp });
  }

  /** Begin eager model warm-up. */
  warm(): void {
    this.send({ type: 'warm' });
  }

  run(tag: string, imageUrl: string, onStage?: (stage: StageKey, raw: string) => void): Promise<PageResult> {
    const jobId = this.nextJob++;
    return new Promise<PageResult>((resolve, reject) => {
      this.jobs.set(jobId, { resolve, reject, onStage });
      this.send({ type: 'run', jobId, tag, imageUrl });
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.jobs.clear();
  }

  private send(msg: ToQuickWorker): void {
    this.worker.postMessage(msg);
  }

  private handle(msg: FromQuickWorker): void {
    switch (msg.type) {
      case 'ready':
        this.warmed = true;
        this.handlers.onReady?.(msg.epNote);
        break;
      case 'load-progress':
        this.handlers.onLoadProgress?.(msg.loaded, msg.total);
        break;
      case 'stage':
        this.jobs.get(msg.jobId)?.onStage?.(msg.stage, msg.raw);
        break;
      case 'result': {
        const job = this.jobs.get(msg.jobId);
        this.jobs.delete(msg.jobId);
        job?.resolve(msg.result);
        break;
      }
      case 'error':
        if (msg.jobId != null) {
          const job = this.jobs.get(msg.jobId);
          this.jobs.delete(msg.jobId);
          job?.reject(msg.error);
        } else {
          this.handlers.onError?.(msg.error);
        }
        break;
    }
  }
}
