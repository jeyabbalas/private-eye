/// <reference lib="webworker" />
/**
 * Quick Read (Pipeline E) Web Worker. Runs the deterministic layout + OCR +
 * tables pipeline off the main thread, so the UI stays responsive. Spawned and
 * warmed as soon as the page loads.
 *
 * Messages are drained strictly one-at-a-time (a promise chain) so eager warm-up
 * can't race a run into a double model-load, and pages process sequentially.
 */
import { setDebug } from '../runtime/logger.ts';
import { ensureE, runE, reocrRegion, eEpNote, type AppEp } from '../runtime/run-e.ts';
import { reportError } from '../runtime/errors.ts';
import type { DocModel } from '../structure/blocks.ts';
import type { FromQuickWorker, StageKey, ToQuickWorker } from './protocol.ts';

const ctx = self as DedicatedWorkerGlobalScope;
let onnxEp: AppEp = 'webgpu';
let chain: Promise<void> = Promise.resolve();

function post(msg: FromQuickWorker): void {
  ctx.postMessage(msg);
}

function stageOf(s: string): StageKey {
  if (s.startsWith('loading')) return 'loading';
  if (s.startsWith('decoding')) return 'decoding';
  return 'analyzing';
}

async function handle(msg: ToQuickWorker): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        setDebug(msg.debug);
        onnxEp = msg.onnxEp;
        break;

      case 'warm':
        await ensureE((s) => post({ type: 'stage', jobId: -1, stage: stageOf(s), raw: s }), onnxEp);
        post({ type: 'ready', epNote: eEpNote() });
        break;

      case 'run': {
        const { jobId, imageUrl } = msg;
        const run = await runE(imageUrl, (s) => post({ type: 'stage', jobId, stage: stageOf(s), raw: s }), onnxEp);
        // Pipeline E returns the DocModel in `debug.doc`; carry its blocks (the
        // structure the review UI links to provenance) but drop the bulky raw
        // layout/OCR payloads that the uncertainty layer already distills.
        const doc = (run.debug as { doc?: DocModel } | undefined)?.doc;
        post({
          type: 'result',
          jobId,
          result: {
            markdown: run.markdown,
            uncertainty: run.uncertainty,
            verification: run.verification,
            blocks: doc?.blocks,
            note: run.note,
            stageMs: run.stageMs,
            totalMs: run.totalMs,
            width: run.uncertainty?.width ?? doc?.width ?? 0,
            height: run.uncertainty?.height ?? doc?.height ?? 0,
          },
        });
        post({ type: 'ready', epNote: eEpNote() });
        break;
      }

      case 'reocr-region': {
        const { jobId, imageUrl, originX, originY } = msg;
        const blocks = await reocrRegion(imageUrl, originX, originY);
        post({ type: 'region-result', jobId, blocks });
        break;
      }
    }
  } catch (err) {
    const jobId = msg.type === 'run' || msg.type === 'reocr-region' ? msg.jobId : null;
    post({ type: 'error', jobId, error: reportError(err, { context: `quick-worker:${msg.type}`, executionProviders: { onnxEp } }) });
  }
}

ctx.onmessage = (e: MessageEvent<ToQuickWorker>) => {
  chain = chain.then(() => handle(e.data));
};
