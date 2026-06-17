/**
 * Pipeline router — the app's single entry point for digitizing one page.
 * Implements the policy from the eval record (see docs/ROUTING.md):
 *
 *   run G ('tables-only' escalation, 'replace' numeric anchor)
 *     → read Pipeline V's verdict over the OCR reference:
 *         'pass' | 'review' → keep G's output (review = still G, just flag uncertainty)
 *         'fallback'        → re-run E (deterministic floor) and return that instead
 *
 * Both pipelines attach the same UncertaintyLayer, so the human-in-the-loop
 * review UI consumes `result.uncertainty` identically regardless of which ran.
 *
 * This is deliberately thin and UI-agnostic: it takes a GProgress (so the caller
 * can stream G's per-region decode) and returns a plain result object.
 */
import type { UncertaintyLayer } from '../structure/uncertainty.ts';
import type { VerificationResult } from '../structure/verify.ts';
import { runE } from './run-e.ts';
import { runG, type AppEp, type GMode, type GProgress } from './run-g-live.ts';

export type RoutedPipeline = 'G' | 'E';

export interface RoutedResult {
  /** Which pipeline produced `markdown` (G unless V forced the E fallback). */
  pipeline: RoutedPipeline;
  markdown: string;
  /** Uncertainty for the chosen output (undefined only if E returns none). */
  uncertainty?: UncertaintyLayer;
  /** Pipeline V verdict for the chosen output. */
  verification?: VerificationResult;
  /** Human-readable provenance line. */
  note: string;
  /** When G tripped the gate, its verdict (the reason E was substituted). */
  fallbackFrom?: VerificationResult;
}

export interface RouteOptions {
  /** G escalation mode; the ship default is 'tables-only'. */
  gmode?: GMode;
  /** ONNX execution provider for the layout+OCR prefix (E and G share it). */
  onnxEp?: AppEp;
  /** Execution provider for the GLM-OCR VLM (webgpu offloads the vision encoder). */
  vlmEp?: AppEp;
  cancel?: AbortSignal;
}

export async function runDocument(
  tag: string,
  imageUrl: string,
  p: GProgress,
  opts: RouteOptions = {},
): Promise<RoutedResult> {
  const gmode = opts.gmode ?? 'tables-only';
  const onnxEp = opts.onnxEp ?? 'webgpu';
  const vlmEp = opts.vlmEp ?? 'webgpu';

  const g = await runG(tag, imageUrl, gmode, p, opts.cancel, onnxEp, vlmEp);
  if (g.verification.verdict !== 'fallback') {
    return {
      pipeline: 'G',
      markdown: g.markdown,
      uncertainty: g.uncertainty,
      verification: g.verification,
      note: `G/${gmode} · verdict ${g.verification.verdict} · ${g.note}`,
    };
  }

  // V tripped the no-fabrication gate on G → substitute E's deterministic output
  // (every E token is copied from an OCR line, so E cannot fabricate).
  p.onStatus('G verdict=fallback → running Pipeline E (deterministic floor)…');
  const e = await runE(imageUrl, (s) => p.onStatus(s), onnxEp);
  return {
    pipeline: 'E',
    markdown: e.markdown,
    uncertainty: e.uncertainty,
    verification: e.verification,
    note: `E fallback (G verdict=fallback: ${g.verification.summary})`,
    fallbackFrom: g.verification,
  };
}
