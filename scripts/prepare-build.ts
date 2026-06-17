/**
 * Pre-build / pre-dev staging (run by `npm run dev` and `npm run build`).
 *
 * Produces the patched runtimes and vendors every SAME-ORIGIN asset into
 * `public/` so Vite copies them into dist/ under the configured `base`:
 *   - onnxruntime-web WASM/glue  -> public/ort/
 *   - memory-patched wllama       -> public/wllama-patched/
 *   - patched layout graph + yml  -> public/models/layout/doclayoutv3/
 *
 * Large model WEIGHTS (PP-OCRv5 det/rec, SLANet, the 130 MB layout .onnx.data,
 * and the 1.43 GB GLM-OCR GGUF) are NOT vendored — they download at runtime
 * from the HuggingFace CDN (src/runtime/assets.ts). Only public weights are
 * fetched inbound; no user document ever leaves the browser.
 *
 * Flags:
 *   --skip-models   stage only ort + wllama (fast shell iteration; skips the
 *                   one-time ~130 MB layout fetch). Do NOT use for production.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePatchedWllama } from './patch-wllama.ts';

const ROOT = join(import.meta.dirname, '..');
const skipModels = process.argv.includes('--skip-models');

function stageOrt(): void {
  const src = join(ROOT, 'node_modules/onnxruntime-web/dist');
  const dst = join(ROOT, 'public/ort');
  mkdirSync(dst, { recursive: true });
  const files = readdirSync(src).filter((f) => /^ort-.*\.(wasm|mjs)$/.test(f));
  for (const f of files) copyFileSync(join(src, f), join(dst, f));
  console.log(`staged ${files.length} onnxruntime-web runtime files -> public/ort/`);
}

function stageWllama(): void {
  const { wllamaNpm, patched } = ensurePatchedWllama();
  const src = join(ROOT, 'out/wllama-patched');
  const dst = join(ROOT, 'public/wllama-patched');
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(src, 'index.js'), join(dst, 'index.js'));
  copyFileSync(join(src, 'wllama.wasm'), join(dst, 'wllama.wasm'));
  console.log(`staged wllama runtime (@wllama/wllama@${wllamaNpm}${patched ? ', memory-cap patched' : ', stock'}) -> public/wllama-patched/`);
}

function stageLayout(): void {
  // Fetch the layout model (the patch needs the upstream .onnx graph on disk)
  // and run the WebGPU ceil_mode patch via fetch-models, then vendor only the
  // tiny patched graph + its yml. The 130 MB .onnx.data stays remote (HF).
  // Run on plain Node type-stripping (no tsx/esbuild).
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/fetch-models.ts', '--only', 'doclayoutv3'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  const src = join(ROOT, 'models/layout/doclayoutv3');
  const dst = join(ROOT, 'public/models/layout/doclayoutv3');
  mkdirSync(dst, { recursive: true });
  copyFileSync(join(src, 'PP-DocLayoutV3.patched.onnx'), join(dst, 'PP-DocLayoutV3.patched.onnx'));
  copyFileSync(join(src, 'inference.yml'), join(dst, 'inference.yml'));
  console.log('staged patched layout graph + inference.yml -> public/models/layout/doclayoutv3/');
}

stageOrt();
stageWllama();
if (skipModels) {
  console.log('skipped layout model staging (--skip-models) — Quick Read will not run until staged');
} else {
  stageLayout();
}
console.log('prepare-build complete.');
