/** Maps a pipeline id to its adapter factory. Trimmed for this app to Pipeline E
 *  ('ppstructure', the deterministic floor / fallback). Pipeline G is not a
 *  PipelineAdapter here — it runs live, streaming, per-region under wllama via
 *  app/run-g-live.ts; the G→V→E router is app/run-doc.ts (see docs/ROUTING.md). */
import type { PipelineAdapter } from './types.ts';
import { createPpstructurePipeline } from './e-ppstructure.ts';

export type PipelineId = PipelineAdapter['id'];

export function createPipeline(id: PipelineId, options: Record<string, string> = {}): PipelineAdapter {
  switch (id) {
    case 'ppstructure':
      return createPpstructurePipeline(options);
    default:
      throw new Error(`pipeline '${id}' is not bundled in this app (only 'ppstructure' / Pipeline E; Pipeline G is app/run-g-live.ts)`);
  }
}

export const IMPLEMENTED: PipelineId[] = ['ppstructure'];
