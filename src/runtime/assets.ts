/**
 * The single asset-URL resolver. Two kinds of asset:
 *
 *   vendored(rel)  — SAME-ORIGIN files staged into public/ by prepare-build and
 *                    served under Vite `base` (onnxruntime-web WASM, the patched
 *                    wllama runtime, the patched layout graph + yml, calibration).
 *   modelUrl(rel)  — large model WEIGHTS, fetched at runtime from the HuggingFace
 *                    CDN. Falls back to vendored() for the small same-origin
 *                    artifacts (patched graph, ymls, calibration.json).
 *
 * PRIVACY: the only cross-origin traffic is GET requests pulling PUBLIC model
 * weights from HuggingFace. No user document, image, or OCR text ever leaves
 * the browser. Works identically on the main thread and inside Web Workers
 * (`self.location.origin` is the page origin in both).
 */

const BASE = import.meta.env.BASE_URL; // e.g. '/private-eye/'
const ORIGIN = self.location.origin;

/** Base-relative same-origin URL for a vendored asset (respects the Pages subpath). */
export function vendored(rel: string): string {
  return new URL(BASE + rel.replace(/^\//, ''), ORIGIN).toString();
}

/**
 * Model weight sources, pinned to immutable commits. The Quick Read weights are mirrored
 * into our own HF namespace (jeyabbalas/private-eye-models) so the always-used path never
 * depends on a third-party repo moving, going private, or being rewritten; Deep Read's
 * large GGUF stays on the stable official ggml-org repo, pinned to a commit. `dir` is the
 * repo subpath a source lives under (omitted for repos whose files sit at the root).
 *
 * To re-mirror or re-pin: upload the files (scripts/fetch-models.ts lists every one),
 * update `repo`/`rev`/`dir` here AND in the matching block in scripts/fetch-models.ts,
 * then bump CACHE in model-cache.ts so returning users refetch from the new URLs.
 */
type Source = { repo: string; rev: string; dir?: string };
const SOURCES = {
  ppocrDet: { repo: 'jeyabbalas/private-eye-models', rev: 'f1ec7e4768b2418c5e8cd88e9aaac217a00f6f97', dir: 'ppocr/det-medium' },
  ppocrRec: { repo: 'jeyabbalas/private-eye-models', rev: 'f1ec7e4768b2418c5e8cd88e9aaac217a00f6f97', dir: 'ppocr/rec-medium' },
  slanet: { repo: 'jeyabbalas/private-eye-models', rev: 'f1ec7e4768b2418c5e8cd88e9aaac217a00f6f97', dir: 'slanet' },
  layout: { repo: 'jeyabbalas/private-eye-models', rev: 'f1ec7e4768b2418c5e8cd88e9aaac217a00f6f97', dir: 'layout/doclayoutv3' },
  glmOcr: { repo: 'ggml-org/GLM-OCR-GGUF', rev: '65a42de1148dbed2297e922b5dbc7d9b70c36578' },
} as const;

const hf = (src: Source, file: string): string =>
  `https://huggingface.co/${src.repo}/resolve/${src.rev}/${src.dir ? src.dir + '/' : ''}${file}`;

/** models/-relative path -> HuggingFace CDN URL. Anything not listed here is
 *  resolved same-origin via vendored() (the patched layout graph, the .yml
 *  sidecars that travel with the patched graph, and calibration.json). */
const MODEL_CDN: Record<string, string> = {
  // Layout: the patched graph is vendored; its 130 MB external weights are remote.
  'layout/doclayoutv3/PP-DocLayoutV3.onnx.data': hf(SOURCES.layout, 'PP-DocLayoutV3.onnx.data'),
  // PP-OCRv6 detector + recognizer (unified multilingual rec), keyed by tier.
  // medium is the app default (PPOCR_DEFAULTS.tier in src/engines/ppocr/index.ts);
  // add tiny/small entries here if you switch the default tier.
  'ppocr/det-medium/inference.onnx': hf(SOURCES.ppocrDet, 'inference.onnx'),
  'ppocr/det-medium/inference.yml': hf(SOURCES.ppocrDet, 'inference.yml'),
  'ppocr/rec-medium/inference.onnx': hf(SOURCES.ppocrRec, 'inference.onnx'),
  'ppocr/rec-medium/inference.yml': hf(SOURCES.ppocrRec, 'inference.yml'),
  // SLANet table structure.
  'slanet/inference.onnx': hf(SOURCES.slanet, 'inference.onnx'),
  'slanet/inference.yml': hf(SOURCES.slanet, 'inference.yml'),
  // Deep Read VLM (GLM-OCR GGUF pair) — consumed by run-g-live.
  'bakeoff/glm-ocr-q8/GLM-OCR-Q8_0.gguf': hf(SOURCES.glmOcr, 'GLM-OCR-Q8_0.gguf'),
  'bakeoff/glm-ocr-q8/mmproj-GLM-OCR-Q8_0.gguf': hf(SOURCES.glmOcr, 'mmproj-GLM-OCR-Q8_0.gguf'),
};

/** Resolve a models/-relative path to its runtime URL (HF CDN or same-origin). */
export function modelUrl(rel: string): string {
  const key = rel.replace(/^\//, '');
  return MODEL_CDN[key] ?? vendored('models/' + key);
}

/** Direct accessors for the Deep Read GGUF pair (used by run-g-live). */
export const GLM_OCR_MODEL_URL = MODEL_CDN['bakeoff/glm-ocr-q8/GLM-OCR-Q8_0.gguf']!;
export const GLM_OCR_MMPROJ_URL = MODEL_CDN['bakeoff/glm-ocr-q8/mmproj-GLM-OCR-Q8_0.gguf']!;

/** Vendored onnxruntime-web WASM directory (for ort.env.wasm.wasmPaths). */
export const ORT_WASM_DIR = vendored('ort/');
/** Vendored patched-wllama runtime files. */
export const WLLAMA_INDEX_URL = vendored('wllama-patched/index.js');
export const WLLAMA_WASM_URL = vendored('wllama-patched/wllama.wasm');
