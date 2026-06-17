/**
 * Main-thread client wrapping the Quick Read worker in a Promise/event API, so
 * the rest of the app never touches postMessage directly.
 */
import type { AppError } from '../runtime/errors.ts';
import type { AppEp } from '../runtime/run-e.ts';
import type { Block } from '../structure/blocks.ts';
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

interface RegionJob {
  resolve(blocks: Block[]): void;
  reject(e: AppError): void;
}

export class QuickClient {
  private readonly worker: Worker;
  private nextJob = 1;
  private readonly jobs = new Map<number, Job>();
  private readonly regionJobs = new Map<number, RegionJob>();
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

  /** OCR a user-drawn region (Phase 4). `imageUrl` is a page-crop object URL;
   *  the origin offsets the worker's result back into page coordinates. Resolves
   *  with the assembled blocks (page coords), or [] when no text was found. */
  reocrRegion(imageUrl: string, originX: number, originY: number): Promise<Block[]> {
    const jobId = this.nextJob++;
    return new Promise<Block[]>((resolve, reject) => {
      this.regionJobs.set(jobId, { resolve, reject });
      this.send({ type: 'reocr-region', jobId, imageUrl, originX, originY });
    });
  }

  terminate(): void {
    this.worker.terminate();
    this.jobs.clear();
    this.regionJobs.clear();
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
      case 'region-result': {
        const job = this.regionJobs.get(msg.jobId);
        this.regionJobs.delete(msg.jobId);
        job?.resolve(msg.blocks);
        break;
      }
      case 'error':
        if (msg.jobId != null) {
          const job = this.jobs.get(msg.jobId);
          const region = this.regionJobs.get(msg.jobId);
          this.jobs.delete(msg.jobId);
          this.regionJobs.delete(msg.jobId);
          if (job) job.reject(msg.error);
          else if (region) region.reject(msg.error);
          else this.handlers.onError?.(msg.error);
        } else {
          this.handlers.onError?.(msg.error);
        }
        break;
    }
  }
}
