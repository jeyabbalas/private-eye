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
 * Model weight sources, one entry per upstream HuggingFace repo. To remove the
 * third-party dependency and make loads reproducible, MIRROR these files into your
 * own HF namespace and PIN a revision:
 *   1. upload the files (scripts/fetch-models.ts lists every one) under e.g.
 *      `jeyabbalas/private-eye-models`;
 *   2. point `repo` at your repo and set `rev` to the mirrored commit SHA;
 *   3. bump CACHE in model-cache.ts so returning users refetch from the new URLs.
 * Until pinned, these track the upstream repos at `main` (a moving ref): a rename,
 * deletion, or reupload upstream breaks loads with no fallback — and the 130 MB
 * layout `.data` in particular lives on an individual account.
 */
const SOURCES = {
  ppocrDet: { repo: 'PaddlePaddle/PP-OCRv6_medium_det_onnx', rev: 'main' },
  ppocrRec: { repo: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx', rev: 'main' },
  slanet: { repo: 'PaddlePaddle/SLANet_plus_onnx', rev: 'main' },
  layout: { repo: 'Bei0001/PP-DocLayoutV3-ONNX', rev: 'main' },
  glmOcr: { repo: 'ggml-org/GLM-OCR-GGUF', rev: 'main' },
} as const;

const hf = (src: { repo: string; rev: string }, file: string): string =>
  `https://huggingface.co/${src.repo}/resolve/${src.rev}/${file}`;

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
