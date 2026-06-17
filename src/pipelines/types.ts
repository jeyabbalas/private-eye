/** Pipeline contract: every candidate implements this, runs in Node and browser. */
import type { RasterImage } from '../core/types.ts';
import type { ImageSource, ModelSpec, RuntimeContext } from '../adapters/types.ts';
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import type { VerificationResult } from '../structure/verify.ts';

/** One page handed to a pipeline. Engines pick what they need: tesseract uses
 *  `source` (a path/url), the ONNX engines use decoded `image`. */
export interface PageInput {
  image: RasterImage;
  source: ImageSource;
}

export interface InitStats {
  initMs: number;
  downloadBytes: number;
}

export interface PageRun {
  markdown: string;
  totalMs: number;
  stageMs: Record<string, number>;
  /** Page-level caveat surfaced into results.json (e.g. llmstruct fallback). */
  note?: string;
  /** Serializable uncertainty contract for the human-in-the-loop app. `undefined`
   *  when no reliable estimate is available (distinct from an all-clear layer). */
  uncertainty?: UncertaintyLayer;
  /** Runtime verbatim-coverage verdict (Pipeline V): per-page proof that the
   *  output contains only tokens the OCR saw, with the exceptions flagged. */
  verification?: VerificationResult;
  /** Optional structured debug payload for overlays (not persisted in results.json). */
  debug?: unknown;
}

export interface PipelineAdapter {
  id: 'tess' | 'ppocr' | 'ppstructure' | 'llmstruct' | 'vlm';
  variant: string;
  models: ModelSpec[];
  init(ctx: RuntimeContext): Promise<InitStats>;
  runPage(input: PageInput, ctx: RuntimeContext): Promise<PageRun>;
  dispose(): Promise<void>;
}

export interface PipelineFactory {
  id: PipelineAdapter['id'];
  /** Human-readable variant label for this configuration. */
  variant: string;
  create(options?: Record<string, string>): PipelineAdapter;
}
