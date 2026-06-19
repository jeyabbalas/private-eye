/**
 * Headless OCR verification harness. Runs the PP-OCR engine (det+rec only) over
 * the pathology-report fixtures and scores how much of the ground truth the raw
 * OCR recovers — the right question for "does the det+rec stage see all the
 * content." Runs on the Node adapter (src/adapters/node.ts), so it
 * exercises the exact engine both pipelines share.
 *
 * SCOPE: this runs flat OCR (a list of lines), NOT the full pipeline — so it
 * measures RECALL / coverage of GT field-values and tokens, not CER/precision,
 * reading order, table structure, or fabrication (those need layout+assembly and
 * are checked in the browser, Part C of the plan).
 *
 * Prereq: `npm run fetch-models -- --only ppocr` (stages det/rec onnx+yml into
 * models/). Usage:
 *   npm run ocr:harness                              # default v6-medium
 *   npm run ocr:harness -- --tier small              # a single v6 tier
 *   npm run ocr:harness -- --compare v6-small,v6-medium    # side-by-side delta
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNodeContext } from '../src/adapters/node.ts';
import { PpocrEngine, type PpocrTier } from '../src/engines/ppocr/index.ts';
import { docToText, parseDoc } from '../src/eval/mdast.ts';
import { extractNumbers, extractWords, normalizeField } from '../src/eval/normalize.ts';
import { tokensMissingFromPool, withinEdit1 } from '../src/eval/token-match.ts';
import type { OcrResult, RasterImage } from '../src/core/types.ts';

const REPO_ROOT = join(import.meta.dirname, '..');

const argv = process.argv.slice(2);
function arg(name: string, def: string): string {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : def;
}
const compare = arg('--compare', '');
const tier = arg('--tier', 'medium');
const fixturesDir = arg('--fixtures', join(REPO_ROOT, 'test/fixtures/pathology_reports'));
const gtDir = arg('--gt', join(REPO_ROOT, 'test/fixtures/ground_truth'));
const limit = Number(arg('--limit', '0')) || 0;

/** Map a variant name to engine options (v6 tier → tier-derived model paths). */
function variantOpts(name: string): { tier: PpocrTier } {
  const m = /^v6-(tiny|small|medium)$/.exec(name);
  if (m) return { tier: m[1] as PpocrTier };
  throw new Error(`unknown variant "${name}" (expected v6-tiny | v6-small | v6-medium)`);
}

const FIELD_KINDS = ['date', 'id', 'name', 'text'] as const;
type FieldKind = (typeof FIELD_KINDS)[number];
interface GtField {
  name: string;
  value: string;
  normalize: FieldKind;
  page: number;
}

/** Whitespace tokens, normalized for the field kind, with edge punctuation trimmed. */
function tokenize(text: string, kind: FieldKind): string[] {
  return text
    .split(/\s+/)
    .map((t) => normalizeField(t, kind).replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter((t) => t.length > 0);
}

/** A field is a hit if every normalized token of its value is in the OCR pool
 *  (exact or within edit-1) — tolerant of the OCR misreads CER already counts. */
function scoreFields(ocrText: string, fields: GtField[]): { found: number; total: number } {
  const pools: Record<FieldKind, Set<string>> = {
    date: new Set(tokenize(ocrText, 'date')),
    id: new Set(tokenize(ocrText, 'id')),
    name: new Set(tokenize(ocrText, 'name')),
    text: new Set(tokenize(ocrText, 'text')),
  };
  let found = 0;
  for (const f of fields) {
    const kind: FieldKind = FIELD_KINDS.includes(f.normalize) ? f.normalize : 'text';
    const expected = tokenize(f.value, kind);
    if (expected.length > 0 && expected.every((tok) => withinEdit1(tok, pools[kind]))) found++;
  }
  return { found, total: fields.length };
}

function recall(gtTokens: string[], ocrPool: Set<string>): { found: number; total: number } {
  if (gtTokens.length === 0) return { found: 0, total: 0 };
  const missing = tokensMissingFromPool(gtTokens, ocrPool).length;
  return { found: gtTokens.length - missing, total: gtTokens.length };
}

interface Score {
  fixture: string;
  nLines: number;
  field: { found: number; total: number };
  num: { found: number; total: number };
  word: { found: number; total: number };
  meanConf: number;
  detMs: number;
  recMs: number;
}

function scoreFixture(
  fixture: string,
  ocr: OcrResult,
  detMs: number,
  recMs: number,
  gtMd: string | null,
  fields: GtField[],
): Score {
  const ocrText = ocr.lines.map((l) => l.text).join('\n');
  const gtText = gtMd ? docToText(parseDoc(gtMd)) : '';
  return {
    fixture,
    nLines: ocr.lines.length,
    field: fields.length ? scoreFields(ocrText, fields) : { found: 0, total: 0 },
    num: recall(extractNumbers(gtText), new Set(extractNumbers(ocrText))),
    word: recall(extractWords(gtText), new Set(extractWords(ocrText))),
    meanConf: ocr.lines.length ? ocr.lines.reduce((a, l) => a + l.conf, 0) / ocr.lines.length : 0,
    detMs,
    recMs,
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
async function readFields(path: string, page: number): Promise<GtField[]> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { fields?: GtField[] };
    return (parsed.fields ?? []).filter((f) => f.page === page);
  } catch {
    return [];
  }
}

function pct(found: number, total: number): string {
  return total ? `${((100 * found) / total).toFixed(1)}%` : '—';
}
function agg(rows: Score[]) {
  const sum = (sel: (s: Score) => number) => rows.reduce((a, s) => a + sel(s), 0);
  return {
    field: [sum((s) => s.field.found), sum((s) => s.field.total)] as const,
    num: [sum((s) => s.num.found), sum((s) => s.num.total)] as const,
    word: [sum((s) => s.word.found), sum((s) => s.word.total)] as const,
    conf: rows.length ? sum((s) => s.meanConf) / rows.length : 0,
    detMs: rows.length ? sum((s) => s.detMs) / rows.length : 0,
    recMs: rows.length ? sum((s) => s.recMs) / rows.length : 0,
  };
}

function row(cells: (string | number)[]): string {
  const w = [22, 6, 8, 8, 8, 7, 9, 9];
  return cells.map((c, i) => (i === 0 ? String(c).padEnd(w[i]!) : String(c).padStart(w[i]!))).join('');
}
function printVariant(name: string, rows: Score[]): void {
  console.log(`\nvariant: ${name}`);
  console.log(row(['fixture', 'lines', 'field', 'num', 'word', 'conf', 'det ms', 'rec ms']));
  for (const s of rows) {
    console.log(
      row([
        s.fixture,
        s.nLines,
        pct(s.field.found, s.field.total),
        pct(s.num.found, s.num.total),
        pct(s.word.found, s.word.total),
        s.meanConf.toFixed(2),
        Math.round(s.detMs),
        Math.round(s.recMs),
      ]),
    );
  }
  const a = agg(rows);
  console.log(
    row([
      'AGGREGATE',
      '',
      pct(a.field[0], a.field[1]),
      pct(a.num[0], a.num[1]),
      pct(a.word[0], a.word[1]),
      a.conf.toFixed(2),
      Math.round(a.detMs),
      Math.round(a.recMs),
    ]),
  );
}
function printDelta(a: { variant: string; rows: Score[] }, b: { variant: string; rows: Score[] }): void {
  const ga = agg(a.rows);
  const gb = agg(b.rows);
  const rate = (x: readonly [number, number]): number => (x[1] ? (100 * x[0]) / x[1] : NaN);
  const fmt = (v: number): string => (Number.isNaN(v) ? '—' : `${v.toFixed(1)}%`);
  const delta = (av: number, bv: number): string =>
    Number.isNaN(av) || Number.isNaN(bv) ? '—' : `${bv - av >= 0 ? '+' : ''}${(bv - av).toFixed(1)}`;
  const line = (label: string, av: number, bv: number): string =>
    [label.padEnd(8), fmt(av).padStart(10), fmt(bv).padStart(10), delta(av, bv).padStart(8)].join('');
  console.log(`\n=== DELTA (${b.variant} − ${a.variant}) ===`);
  console.log(['metric'.padEnd(8), a.variant.padStart(10), b.variant.padStart(10), 'Δ'.padStart(8)].join(''));
  console.log(line('field', rate(ga.field), rate(gb.field)));
  console.log(line('num', rate(ga.num), rate(gb.num)));
  console.log(line('word', rate(ga.word), rate(gb.word)));
}

async function main(): Promise<void> {
  const files = (await readdir(fixturesDir)).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  const fixtures = limit > 0 ? files.slice(0, limit) : files;
  const variants = compare ? compare.split(',').map((s) => s.trim()).filter(Boolean) : [`v6-${tier}`];

  console.log('OCR verification harness — flat det+rec coverage vs ground truth');
  console.log('Measures RECALL/coverage of GT field-values & tokens by raw OCR.');
  console.log('NOT measured here (need the full pipeline): CER/precision, reading order, tables, fabrication.');
  console.log(`fixtures: ${fixtures.length} PNG(s) from ${fixturesDir} (PDF skipped)`);

  const ctx = createNodeContext();
  const imgCache = new Map<string, RasterImage>();
  const getImage = async (path: string): Promise<RasterImage> => {
    let im = imgCache.get(path);
    if (!im) {
      im = await ctx.decodeImage(path);
      imgCache.set(path, im);
    }
    return im;
  };

  const results: { variant: string; rows: Score[] }[] = [];
  for (const v of variants) {
    const eng = new PpocrEngine();
    await eng.init(ctx, variantOpts(v));
    const rows: Score[] = [];
    for (const file of fixtures) {
      const m = /^(.+)\.(\d+)\.png$/i.exec(file);
      if (!m) continue;
      const doc = m[1]!;
      const pageStr = m[2]!;
      const page = Number(pageStr);
      const image = await getImage(join(fixturesDir, file));
      const { result, detMs, recMs } = await eng.run(image);
      const gtMd = await readText(join(gtDir, `${doc}.${pageStr}.gt.md`));
      const fields = await readFields(join(gtDir, `${doc}.fields.json`), page);
      rows.push(scoreFixture(file, result, detMs, recMs, gtMd, fields));
    }
    await eng.dispose();
    printVariant(v, rows);
    results.push({ variant: v, rows });
  }
  if (results.length === 2) printDelta(results[0]!, results[1]!);
}

await main();
