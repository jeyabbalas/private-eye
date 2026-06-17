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

const hf = (repo: string, file: string): string => `https://huggingface.co/${repo}/resolve/main/${file}`;

/** models/-relative path -> HuggingFace CDN URL. Anything not listed here is
 *  resolved same-origin via vendored() (the patched layout graph, the .yml
 *  sidecars that travel with the patched graph, and calibration.json). */
const MODEL_CDN: Record<string, string> = {
  // Layout: the patched graph is vendored; its 130 MB external weights are remote.
  'layout/doclayoutv3/PP-DocLayoutV3.onnx.data': hf('Bei0001/PP-DocLayoutV3-ONNX', 'PP-DocLayoutV3.onnx.data'),
  // PP-OCRv5 detector + recognizer (English).
  'ppocr/det-mobile/inference.onnx': hf('PaddlePaddle/PP-OCRv5_mobile_det_onnx', 'inference.onnx'),
  'ppocr/det-mobile/inference.yml': hf('PaddlePaddle/PP-OCRv5_mobile_det_onnx', 'inference.yml'),
  'ppocr/rec-en-mobile/inference.onnx': hf('PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx', 'inference.onnx'),
  'ppocr/rec-en-mobile/inference.yml': hf('PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx', 'inference.yml'),
  // SLANet table structure.
  'slanet/inference.onnx': hf('PaddlePaddle/SLANet_plus_onnx', 'inference.onnx'),
  'slanet/inference.yml': hf('PaddlePaddle/SLANet_plus_onnx', 'inference.yml'),
  // Deep Read VLM (GLM-OCR GGUF pair) — consumed by run-g-live.
  'bakeoff/glm-ocr-q8/GLM-OCR-Q8_0.gguf': hf('ggml-org/GLM-OCR-GGUF', 'GLM-OCR-Q8_0.gguf'),
  'bakeoff/glm-ocr-q8/mmproj-GLM-OCR-Q8_0.gguf': hf('ggml-org/GLM-OCR-GGUF', 'mmproj-GLM-OCR-Q8_0.gguf'),
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
