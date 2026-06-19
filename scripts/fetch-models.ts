/**
 * Downloads the Pipeline E + G model artifacts into models/ (all gitignored;
 * only models/ppocr/calibration.json is committed) and writes models/manifest.json
 * with measured byte sizes + sha256, then patches the layout graph for WebGPU
 * (ensurePatchedLayoutModel). Run once after install:  npm run fetch-models
 *
 *   E: PP-DocLayoutV3 (layout) + PP-OCRv6 det/rec (medium) (OCR) + SLANet_plus (tables)
 *   G: the above prefix + GLM-OCR Q8_0 GGUF pair (the per-region doc-VLM)
 *
 * All weights are fetched from HuggingFace and served same-origin by the app
 * (vite.config.ts diskAssets) — nothing is uploaded at runtime.
 */
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ensurePatchedLayoutModel } from './patch-layout.ts';

const ROOT = join(import.meta.dirname, '..');
const MODELS_DIR = join(ROOT, 'models');

interface FileSpec {
  url: string;
  /** Path relative to models/ */
  dest: string;
}
interface ModelGroup {
  id: string;
  license: string;
  source: string;
  files: FileSpec[];
}

const hf = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;

const GROUPS: ModelGroup[] = [
  {
    id: 'ppocr-det-medium',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_det_onnx',
    files: [
      { url: hf('PaddlePaddle/PP-OCRv6_medium_det_onnx', 'inference.onnx'), dest: 'ppocr/det-medium/inference.onnx' },
      { url: hf('PaddlePaddle/PP-OCRv6_medium_det_onnx', 'inference.yml'), dest: 'ppocr/det-medium/inference.yml' },
    ],
  },
  {
    id: 'ppocr-rec-medium',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx',
    files: [
      { url: hf('PaddlePaddle/PP-OCRv6_medium_rec_onnx', 'inference.onnx'), dest: 'ppocr/rec-medium/inference.onnx' },
      { url: hf('PaddlePaddle/PP-OCRv6_medium_rec_onnx', 'inference.yml'), dest: 'ppocr/rec-medium/inference.yml' },
    ],
  },
  // Legacy PP-OCRv5 (mobile det + English rec) — kept only for the verification
  // harness A/B (scripts/ocr-harness.ts --compare). Remove once v6 is confirmed.
  {
    id: 'ppocr-det-mobile',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx',
    files: [
      { url: hf('PaddlePaddle/PP-OCRv5_mobile_det_onnx', 'inference.onnx'), dest: 'ppocr/det-mobile/inference.onnx' },
      { url: hf('PaddlePaddle/PP-OCRv5_mobile_det_onnx', 'inference.yml'), dest: 'ppocr/det-mobile/inference.yml' },
    ],
  },
  {
    id: 'ppocr-rec-en-mobile',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx',
    files: [
      { url: hf('PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx', 'inference.onnx'), dest: 'ppocr/rec-en-mobile/inference.onnx' },
      { url: hf('PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx', 'inference.yml'), dest: 'ppocr/rec-en-mobile/inference.yml' },
    ],
  },
  {
    id: 'slanet-plus',
    license: 'Apache-2.0',
    source: 'https://huggingface.co/PaddlePaddle/SLANet_plus_onnx',
    files: [
      { url: hf('PaddlePaddle/SLANet_plus_onnx', 'inference.onnx'), dest: 'slanet/inference.onnx' },
      { url: hf('PaddlePaddle/SLANet_plus_onnx', 'inference.yml'), dest: 'slanet/inference.yml' },
    ],
  },
  {
    id: 'doclayoutv3-community',
    license: 'Apache-2.0 (community export of PaddlePaddle/PP-DocLayoutV3)',
    source: 'https://huggingface.co/Bei0001/PP-DocLayoutV3-ONNX',
    files: [
      { url: hf('Bei0001/PP-DocLayoutV3-ONNX', 'PP-DocLayoutV3.onnx'), dest: 'layout/doclayoutv3/PP-DocLayoutV3.onnx' },
      { url: hf('Bei0001/PP-DocLayoutV3-ONNX', 'PP-DocLayoutV3.onnx.data'), dest: 'layout/doclayoutv3/PP-DocLayoutV3.onnx.data' },
      { url: hf('Bei0001/PP-DocLayoutV3-ONNX', 'inference.yml'), dest: 'layout/doclayoutv3/inference.yml' },
      { url: hf('Bei0001/PP-DocLayoutV3-ONNX', 'config.json'), dest: 'layout/doclayoutv3/config.json' },
      { url: hf('Bei0001/PP-DocLayoutV3-ONNX', 'preprocessor_config.json'), dest: 'layout/doclayoutv3/preprocessor_config.json' },
    ],
  },
  // Pipeline G VLM: the official GLM-OCR GGUF pair (MIT). Q8_0 is the shipped
  // browser rung — model (~1.43 GB) + mmproj — loaded per-region by
  // app/run-g-live.ts under wllama.
  {
    id: 'glm-ocr-gguf-q8',
    license: 'MIT (official GGUF of zai-org/GLM-OCR)',
    source: 'https://huggingface.co/ggml-org/GLM-OCR-GGUF',
    files: [
      { url: hf('ggml-org/GLM-OCR-GGUF', 'GLM-OCR-Q8_0.gguf'), dest: 'bakeoff/glm-ocr-q8/GLM-OCR-Q8_0.gguf' },
      { url: hf('ggml-org/GLM-OCR-GGUF', 'mmproj-GLM-OCR-Q8_0.gguf'), dest: 'bakeoff/glm-ocr-q8/mmproj-GLM-OCR-Q8_0.gguf' },
    ],
  },
];

/** Streamed (multi-GB GGUFs must never be buffered whole in RAM). */
async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const MAX_ATTEMPTS = 5;

/** Resumable download: socket drops mid-multi-GB-GGUF are routine, so each
 *  retry continues the .part file with a Range request (HF CDN supports it). */
async function download(file: FileSpec): Promise<{ bytes: number; sha256: string; cached: boolean }> {
  const dest = join(MODELS_DIR, file.dest);
  await mkdir(dirname(dest), { recursive: true });
  let cached = false;
  if (existsSync(dest) && (await stat(dest)).size > 0) {
    cached = true;
  } else {
    const tmp = `${dest}.part`;
    const { rename, rm } = await import('node:fs/promises');
    for (let attempt = 1; ; attempt++) {
      try {
        const offset = existsSync(tmp) ? (await stat(tmp)).size : 0;
        const res = await fetch(file.url, {
          redirect: 'follow',
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
        });
        if (offset > 0 && res.status === 200) {
          // Server ignored the Range request — start over.
          await rm(tmp, { force: true });
        } else if (!res.ok || !res.body) {
          throw new Error(`${res.status} ${res.statusText} for ${file.url}`);
        }
        const append = offset > 0 && res.status === 206;
        await pipeline(
          Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
          createWriteStream(tmp, append ? { flags: 'a' } : {}),
        );
        await rename(tmp, dest);
        break;
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) throw err;
        const got = existsSync(tmp) ? ((await stat(tmp)).size / 1e6).toFixed(0) : '0';
        console.log(`  retry ${attempt}/${MAX_ATTEMPTS} for ${file.dest} (have ${got} MB): ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  const size = (await stat(dest)).size;
  return { bytes: size, sha256: await sha256(dest), cached };
}

/** `--only <prefix>` limits fetching to matching group ids (cached groups are
 *  still re-measured into the manifest so its coverage never shrinks). */
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : undefined;

const manifest: Record<string, unknown> = {};
for (const group of GROUPS) {
  if (only && !group.id.startsWith(only) && !group.files.every((f) => existsSync(join(MODELS_DIR, f.dest)))) {
    console.log(`skipped ${group.id} (--only ${only})`);
    continue;
  }
  const files: Record<string, { bytes: number; sha256: string }> = {};
  let total = 0;
  for (const file of group.files) {
    const r = await download(file);
    files[file.dest] = { bytes: r.bytes, sha256: r.sha256 };
    total += r.bytes;
    console.log(`${r.cached ? 'cached' : 'fetched'}  ${file.dest}  ${(r.bytes / 1e6).toFixed(2)} MB`);
  }
  manifest[group.id] = { license: group.license, source: group.source, totalBytes: total, files };
}
await writeFile(join(MODELS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nmanifest written: ${join(MODELS_DIR, 'manifest.json')}`);

// Derived artifacts are provenance-tracked (PROVENANCE.json next to the file),
// not manifest-tracked: the manifest records upstream bytes exactly as fetched.
ensurePatchedLayoutModel();
