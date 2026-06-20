/**
 * Filesystem loaders for the calibration corpus — Node-only (kept out of src/ so
 * the eval layer stays browser-portable). Each adapter converts a dataset's GT
 * into the internal {box, text} normal form (src/eval/corpus.ts). The FUNSD/SROIE
 * datasets are research-licensed and gitignored; the harness reads them from a
 * `--data <dir>` corpus directory holding a manifest.json (see the calibration
 * harness header). The medical transfer set ships with the repo under test/fixtures.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BBox } from '../src/core/types.ts';
import { quadToBox } from '../src/core/types.ts';
import { parseDoc, docToText } from '../src/eval/mdast.ts';
import type { CorpusLine, CorpusPage, CorpusSplit } from '../src/eval/corpus.ts';

function arr4(b: number[]): BBox {
  return { x0: b[0]!, y0: b[1]!, x1: b[2]!, y1: b[3]! };
}

interface FunsdAnno {
  form: { box?: number[]; text?: string; words?: { box: number[]; text: string }[] }[];
}

/** FUNSD: `<dir>/annotations/*.json` + `<dir>/images/*.png`, word-level GT. */
export function loadFunsd(dir: string, split: CorpusSplit, limit?: number): CorpusPage[] {
  const annoDir = join(dir, 'annotations');
  const imgDir = join(dir, 'images');
  if (!existsSync(annoDir) || !existsSync(imgDir)) return [];
  const files = readdirSync(annoDir).filter((f) => f.endsWith('.json')).sort();
  const pages: CorpusPage[] = [];
  for (const f of files) {
    if (limit && pages.length >= limit) break;
    const stem = basename(f, '.json');
    const imagePath = join(imgDir, `${stem}.png`);
    if (!existsSync(imagePath)) continue;
    const anno = JSON.parse(readFileSync(join(annoDir, f), 'utf8')) as FunsdAnno;
    const gtLines: CorpusLine[] = [];
    for (const item of anno.form ?? []) {
      for (const w of item.words ?? []) {
        const t = (w.text ?? '').trim();
        if (t && w.box?.length === 4) gtLines.push({ box: arr4(w.box), text: t });
      }
    }
    if (gtLines.length) pages.push({ id: `funsd/${stem}`, domain: 'funsd', split, imagePath, gtLines });
  }
  return pages;
}

/** SROIE (ICDAR'19 task1): per-image `X.txt` with `x1,y1,...,x4,y4,transcription`. */
export function loadSroie(dir: string, split: CorpusSplit, limit?: number): CorpusPage[] {
  if (!existsSync(dir)) return [];
  const imgs = readdirSync(dir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  const pages: CorpusPage[] = [];
  for (const img of imgs) {
    if (limit && pages.length >= limit) break;
    const stem = img.replace(/\.[^.]+$/, '');
    const txt = join(dir, `${stem}.txt`);
    if (!existsSync(txt)) continue;
    const gtLines: CorpusLine[] = [];
    for (const raw of readFileSync(txt, 'utf8').split(/\r?\n/)) {
      const lineStr = raw.trim();
      if (!lineStr) continue;
      // First 8 comma-separated fields are the quad; the rest (which may itself
      // contain commas) is the transcription.
      const parts = lineStr.split(',');
      if (parts.length < 9) continue;
      const xs = parts.slice(0, 8).map(Number);
      if (xs.some(Number.isNaN)) continue;
      const text = parts.slice(8).join(',').trim();
      if (!text) continue;
      gtLines.push({ box: quadToBox([[xs[0]!, xs[1]!], [xs[2]!, xs[3]!], [xs[4]!, xs[5]!], [xs[6]!, xs[7]!]]), text });
    }
    if (gtLines.length) pages.push({ id: `sroie/${stem}`, domain: 'sroie', split, imagePath: join(dir, img), gtLines });
  }
  return pages;
}

interface ManifestEntry {
  format: 'funsd' | 'sroie';
  dir: string; // relative to the data dir
  split: CorpusSplit;
  limit?: number;
}
interface Manifest {
  datasets: ManifestEntry[];
}

/**
 * Load every dataset declared in `<dataDir>/manifest.json`. Missing data dir or
 * manifest → `[]` (the harness still runs on the always-available medical
 * transfer set and simply reports the public corpus as absent).
 */
export function loadManifest(dataDir: string | undefined): CorpusPage[] {
  if (!dataDir) return [];
  const manifestPath = join(dataDir, 'manifest.json');
  if (!existsSync(manifestPath)) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const pages: CorpusPage[] = [];
  for (const e of manifest.datasets ?? []) {
    const dir = join(dataDir, e.dir);
    if (e.format === 'funsd') pages.push(...loadFunsd(dir, e.split, e.limit));
    else if (e.format === 'sroie') pages.push(...loadSroie(dir, e.split, e.limit));
  }
  return pages;
}

/**
 * Medical transfer set: the synthetic `ho-*` pathology fixtures (+ any real
 * de-identified sample dropped alongside them). GT is markdown → plain text, so
 * these align at page level. Always available, so the harness has a transfer
 * check even before the public corpus is downloaded.
 */
export function loadMedicalTransfer(fixturesDir: string, gtDir: string): CorpusPage[] {
  if (!existsSync(fixturesDir)) return [];
  const pages: CorpusPage[] = [];
  for (const f of readdirSync(fixturesDir).filter((n) => n.endsWith('.png')).sort()) {
    const m = /^(.+?)\.(\d+)\.png$/.exec(f);
    if (!m) continue;
    const tag = `${m[1]}.${m[2]}`;
    const gtPath = join(gtDir, `${tag}.gt.md`);
    if (!existsSync(gtPath)) continue;
    pages.push({
      id: `medical/${tag}`,
      domain: 'medical',
      split: 'transfer',
      imagePath: join(fixturesDir, f),
      gtText: docToText(parseDoc(readFileSync(gtPath, 'utf8'))),
    });
  }
  return pages;
}
