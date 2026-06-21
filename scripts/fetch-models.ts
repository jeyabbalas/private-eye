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

// Upstream model sources, one per HF repo. To mirror + pin (keeps CI reproducible
// and matches the runtime resolver), point `repo` at your mirror and set `rev` to a
// commit SHA — exactly the SOURCES block in src/runtime/assets.ts. Until then these
// track `main` (a moving ref).
type Source = { repo: string; rev: string };
const SOURCES = {
  ppocrDet: { repo: 'PaddlePaddle/PP-OCRv6_medium_det_onnx', rev: 'main' },
  ppocrRec: { repo: 'PaddlePaddle/PP-OCRv6_medium_rec_onnx', rev: 'main' },
  slanet: { repo: 'PaddlePaddle/SLANet_plus_onnx', rev: 'main' },
  layout: { repo: 'Bei0001/PP-DocLayoutV3-ONNX', rev: 'main' },
  glmOcr: { repo: 'ggml-org/GLM-OCR-GGUF', rev: 'main' },
} as const;

const hf = (src: Source, file: string) => `https://huggingface.co/${src.repo}/resolve/${src.rev}/${file}`;
const repoUrl = (src: Source) => `https://huggingface.co/${src.repo}`;

const GROUPS: ModelGroup[] = [
  {
    id: 'ppocr-det-medium',
    license: 'Apache-2.0',
    source: repoUrl(SOURCES.ppocrDet),
    files: [
      { url: hf(SOURCES.ppocrDet, 'inference.onnx'), dest: 'ppocr/det-medium/inference.onnx' },
      { url: hf(SOURCES.ppocrDet, 'inference.yml'), dest: 'ppocr/det-medium/inference.yml' },
    ],
  },
  {
    id: 'ppocr-rec-medium',
    license: 'Apache-2.0',
    source: repoUrl(SOURCES.ppocrRec),
    files: [
      { url: hf(SOURCES.ppocrRec, 'inference.onnx'), dest: 'ppocr/rec-medium/inference.onnx' },
      { url: hf(SOURCES.ppocrRec, 'inference.yml'), dest: 'ppocr/rec-medium/inference.yml' },
    ],
  },
  {
    id: 'slanet-plus',
    license: 'Apache-2.0',
    source: repoUrl(SOURCES.slanet),
    files: [
      { url: hf(SOURCES.slanet, 'inference.onnx'), dest: 'slanet/inference.onnx' },
      { url: hf(SOURCES.slanet, 'inference.yml'), dest: 'slanet/inference.yml' },
    ],
  },
  {
    id: 'doclayoutv3-community',
    license: 'Apache-2.0 (community export of PaddlePaddle/PP-DocLayoutV3)',
    source: repoUrl(SOURCES.layout),
    files: [
      { url: hf(SOURCES.layout, 'PP-DocLayoutV3.onnx'), dest: 'layout/doclayoutv3/PP-DocLayoutV3.onnx' },
      { url: hf(SOURCES.layout, 'PP-DocLayoutV3.onnx.data'), dest: 'layout/doclayoutv3/PP-DocLayoutV3.onnx.data' },
      { url: hf(SOURCES.layout, 'inference.yml'), dest: 'layout/doclayoutv3/inference.yml' },
      { url: hf(SOURCES.layout, 'config.json'), dest: 'layout/doclayoutv3/config.json' },
      { url: hf(SOURCES.layout, 'preprocessor_config.json'), dest: 'layout/doclayoutv3/preprocessor_config.json' },
    ],
  },
  // Pipeline G VLM: the official GLM-OCR GGUF pair (MIT). Q8_0 is the shipped
  // browser rung — model (~1.43 GB) + mmproj — loaded per-region by
  // app/run-g-live.ts under wllama.
  {
    id: 'glm-ocr-gguf-q8',
    license: 'MIT (official GGUF of zai-org/GLM-OCR)',
    source: repoUrl(SOURCES.glmOcr),
    files: [
      { url: hf(SOURCES.glmOcr, 'GLM-OCR-Q8_0.gguf'), dest: 'bakeoff/glm-ocr-q8/GLM-OCR-Q8_0.gguf' },
      { url: hf(SOURCES.glmOcr, 'mmproj-GLM-OCR-Q8_0.gguf'), dest: 'bakeoff/glm-ocr-q8/mmproj-GLM-OCR-Q8_0.gguf' },
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
