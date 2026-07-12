/**
 * Field-pairing verification harness. Runs the FULL Pipeline E (PP-DocLayoutV3
 * layout + PP-OCRv6 det/rec + SLANet tables + region assembly) over the
 * pathology-report PNG fixtures and scores label↔value PAIRING against the
 * gt.md `**Label:** value` lines (src/eval/pairing.ts) — the question the
 * token-recall harness (ocr-harness) cannot answer, because a mispaired value
 * still counts as "found".
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ HOLDOUT RULE — fixtures are TRANSFER-ONLY. No constant anywhere in      │
 * │ src/structure/ may be tuned to move these numbers. Structure decisions  │
 * │ must be within-page relative (gap distributions, mutual-nearest, type   │
 * │ cues); tunable weights are fitted on FUNSD (scripts/pairing-fit.ts,     │
 * │ Stage 3), never here. Run this harness BEFORE and AFTER touching        │
 * │ src/structure/ — aggregate F1 and EVERY leave-one-family-out aggregate  │
 * │ must hold or improve.                                                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Determinism: single-threaded WASM (the Node adapter pins numThreads=1).
 * Prereq: `npm run fetch-models` (~150–200 MB: layout + det/rec + SLANet).
 *
 * Usage:
 *   npm run pairing:harness                       # full E, compare vs baseline
 *   npm run pairing:harness -- --table heuristic  # SLANet-off ablation
 *   npm run pairing:harness -- --limit 2          # quick spot check
 *   npm run pairing:harness -- --update-baseline  # promote current run to baseline
 *                                                 # (baseline changes appear in PR diffs)
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createNodeContext } from '../src/adapters/node.ts';
import { createPpstructurePipeline } from '../src/pipelines/e-ppstructure.ts';
import {
  familyOf,
  leaveOneFamilyOut,
  rates,
  scorePagePairing,
  sumCounts,
  type GtField,
  type PairingCounts,
  type PairingScore,
} from '../src/eval/pairing.ts';
import { renderMarkdown, type DocModel } from '../src/structure/blocks.ts';
import type { OcrResult } from '../src/core/types.ts';

const REPO_ROOT = join(import.meta.dirname, '..');
const BASELINE_PATH = join(REPO_ROOT, 'test/baselines/pairing-baseline.json');

const argv = process.argv.slice(2);
function arg(name: string, def: string): string {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : def;
}
const fixturesDir = arg('--fixtures', join(REPO_ROOT, 'test/fixtures/pathology_reports'));
const gtDir = arg('--gt', join(REPO_ROOT, 'test/fixtures/ground_truth'));
const table = arg('--table', 'slanet');
const limit = Number(arg('--limit', '0')) || 0;
const updateBaseline = argv.includes('--update-baseline');

interface BaselineFile {
  capturedAt: string;
  pipeline: string;
  perFixture: Record<string, PairingCounts>;
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

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const signed = (x: number, digits = 1): string => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;

function row(cells: (string | number)[], w: number[]): string {
  return cells.map((c, i) => (i === 0 ? String(c).padEnd(w[i]!) : String(c).padStart(w[i]!))).join('');
}

const W = [18, 4, 5, 5, 5, 6, 6, 5, 6, 8, 8, 8, 6];
const HEADER = ['fixture', 'gt', 'tp', 'fp', 'mis', 'tabl', 'list', 'unp', 'ocr', 'P', 'R', 'F1', 'crit'];

function scoreRow(name: string, s: { counts: PairingCounts }): string {
  const c = s.counts;
  const r = rates(c);
  return row(
    [
      name,
      c.gtPairs,
      c.tp,
      c.fp,
      c.mispaired,
      c.inTable,
      c.inList,
      c.unpaired,
      c.ocrMiss,
      pct(r.precision),
      pct(r.recall),
      pct(r.f1),
      c.criticalTotal ? pct(r.criticalRecall) : '—',
    ],
    W,
  );
}

function printDeltas(current: Record<string, PairingCounts>, baseline: BaselineFile): boolean {
  console.log(`\n=== DELTA vs baseline (${baseline.capturedAt}, ${baseline.pipeline}) ===`);
  const names = [...new Set([...Object.keys(baseline.perFixture), ...Object.keys(current)])].sort();
  for (const name of names) {
    const b = baseline.perFixture[name];
    const c = current[name];
    if (!b || !c) {
      console.log(`  ${name}: ${!b ? 'NEW (not in baseline)' : 'MISSING from this run'}`);
      continue;
    }
    const parts: string[] = [];
    if (c.tp !== b.tp) parts.push(`tp ${signed(c.tp - b.tp, 0)}`);
    if (c.fp !== b.fp) parts.push(`fp ${signed(c.fp - b.fp, 0)}`);
    if (c.mispaired !== b.mispaired) parts.push(`mispaired ${signed(c.mispaired - b.mispaired, 0)}`);
    if (c.inTable !== b.inTable) parts.push(`inTable ${signed(c.inTable - b.inTable, 0)}`);
    if ((c.inList ?? 0) !== (b.inList ?? 0)) parts.push(`inList ${signed((c.inList ?? 0) - (b.inList ?? 0), 0)}`);
    if (parts.length) console.log(`  ${name}: ${parts.join(', ')}`);
  }

  const common = names.filter((n) => baseline.perFixture[n] && current[n]);
  const bAgg = rates(sumCounts(common.map((n) => baseline.perFixture[n]!)));
  const cAgg = rates(sumCounts(common.map((n) => current[n]!)));
  console.log(`  AGGREGATE: F1 ${pct(bAgg.f1)} → ${pct(cAgg.f1)} (${signed(100 * (cAgg.f1 - bAgg.f1))}), ` +
    `P ${signed(100 * (cAgg.precision - bAgg.precision))}, R ${signed(100 * (cAgg.recall - bAgg.recall))}`);

  // Ship rule: aggregate F1 and EVERY leave-one-family-out aggregate F1 must hold or improve.
  let pass = cAgg.f1 >= bAgg.f1 - 1e-9;
  const bLolo = leaveOneFamilyOut(Object.fromEntries(common.map((n) => [n, baseline.perFixture[n]!])));
  const cLolo = leaveOneFamilyOut(Object.fromEntries(common.map((n) => [n, current[n]!])));
  for (const cur of cLolo) {
    const base = bLolo.find((l) => l.heldOut === cur.heldOut);
    if (!base) continue;
    const d = cur.rates.f1 - base.rates.f1;
    if (d < -1e-9) pass = false;
    console.log(`  LOLO −${cur.heldOut}: F1 ${pct(base.rates.f1)} → ${pct(cur.rates.f1)} (${signed(100 * d)})`);
  }
  console.log(pass ? '  SHIP RULE: PASS (aggregate + every LOLO held or improved)' : '  SHIP RULE: FAIL (a holdout regressed)');
  return pass;
}

async function main(): Promise<void> {
  console.log('Field-pairing harness — full Pipeline E vs gt.md label↔value pairs');
  console.log('HOLDOUT RULE: fixtures are TRANSFER-ONLY — never tune any constant on these numbers.');
  console.log('Buckets: mis = value bound under a WRONG label; tabl/list = binding kept as a 2-col table row / list lead;');
  console.log('         unp = value in the pool but bound nowhere; ocr = OCR never saw the value (not a pairing bug).');

  // Prereq check: the full pipeline needs layout + det/rec (+ SLANet unless --table heuristic).
  const required = [
    'layout/doclayoutv3/PP-DocLayoutV3.onnx',
    'ppocr/det-medium/inference.onnx',
    'ppocr/rec-medium/inference.onnx',
    ...(table === 'slanet' ? ['slanet/inference.onnx'] : []),
  ];
  const missing = required.filter((rel) => !existsSync(join(REPO_ROOT, 'models', rel)));
  if (missing.length) {
    console.error(`\nMissing model files under models/:\n  ${missing.join('\n  ')}`);
    console.error('Run `npm run fetch-models` first (~150–200 MB).');
    process.exitCode = 1;
    return;
  }

  const files = (await readdir(fixturesDir)).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  const fixtures = limit > 0 ? files.slice(0, limit) : files;
  console.log(`fixtures: ${fixtures.length} PNG(s) from ${fixturesDir} (PDF skipped — no headless PDF path yet)`);
  console.log(`pipeline: ppstructure (table=${table}, order=learned, single-threaded WASM)`);

  const runId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = join(REPO_ROOT, 'out/pairing', runId);
  await mkdir(outDir, { recursive: true });

  const ctx = createNodeContext();
  const pipeline = createPpstructurePipeline(table === 'heuristic' ? { table: 'heuristic' } : {});
  await pipeline.init(ctx);

  const perFixture: Record<string, PairingCounts> = {};
  const details: Record<string, PairingScore> = {};
  const pairConfs: number[] = [];

  console.log('\n' + row(HEADER, W));
  for (const file of fixtures) {
    const m = /^(.+)\.(\d+)\.png$/i.exec(file);
    if (!m) continue;
    const doc = m[1]!;
    const pageStr = m[2]!;
    const id = `${doc}.${pageStr}`;
    const gtMd = await readText(join(gtDir, `${doc}.${pageStr}.gt.md`));
    if (!gtMd) {
      console.log(`${id}: no gt.md — skipped`);
      continue;
    }
    const fields = await readFields(join(gtDir, `${doc}.fields.json`), Number(pageStr));
    const image = await ctx.decodeImage(join(fixturesDir, file));
    const run = await pipeline.runPage({ image, source: join(fixturesDir, file) }, ctx);
    const dbg = run.debug as { doc: DocModel; ocr: OcrResult };
    const ocrText = dbg.ocr.lines.map((l) => l.text).join('\n');
    const score = scorePagePairing(gtMd, dbg.doc.blocks, fields, { ocrText });
    perFixture[id] = {
      gtPairs: score.gtPairs,
      tp: score.tp,
      fp: score.fp,
      emitted: score.emitted,
      mispaired: score.mispaired,
      inTable: score.inTable,
      inList: score.inList,
      unpaired: score.unpaired,
      ocrMiss: score.ocrMiss,
      criticalTotal: score.criticalTotal,
      criticalFound: score.criticalFound,
    };
    details[id] = score;
    for (const b of dbg.doc.blocks) if (b.kind === 'kv' && b.pairConf !== undefined) pairConfs.push(b.pairConf);
    await writeFile(join(outDir, `${id}.md`), renderMarkdown(dbg.doc), 'utf8');
    console.log(scoreRow(id, { counts: perFixture[id]! }));
  }
  await pipeline.dispose();

  const total = sumCounts(Object.values(perFixture));
  console.log(scoreRow('AGGREGATE', { counts: total }));

  // Per-family + LOLO (computed from per-fixture counts — no re-runs).
  const families = [...new Set(Object.keys(perFixture).map(familyOf))].sort();
  console.log('\nper-family:');
  for (const fam of families) {
    const c = sumCounts(Object.entries(perFixture).filter(([k]) => familyOf(k) === fam).map(([, v]) => v));
    console.log(scoreRow(`  ${fam}`, { counts: c }));
  }
  const lolo = leaveOneFamilyOut(perFixture);
  console.log('\nleave-one-family-out aggregates (ship rule: every F1 must hold or improve):');
  for (const l of lolo) console.log(scoreRow(`  −${l.heldOut}`, { counts: l.counts }));

  if (pairConfs.length) {
    const sorted = [...pairConfs].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(2);
    console.log(`\npairConf distribution (${sorted.length} kv blocks): min ${q(0)} p10 ${q(0.1)} p50 ${q(0.5)} p90 ${q(0.9)}`);
  }

  const summary = {
    runId,
    capturedAt: new Date().toISOString(),
    pipeline: `ppstructure medium@960+${table}+learned`,
    perFixture,
    aggregate: { counts: total, rates: rates(total) },
    lolo: lolo.map((l) => ({ heldOut: l.heldOut, counts: l.counts, rates: l.rates })),
    outcomes: Object.fromEntries(
      Object.entries(details).map(([k, s]) => [
        k,
        s.outcomes.filter((o) => o.outcome !== 'paired').map((o) => ({ label: o.gt.label, value: o.gt.value, outcome: o.outcome, pred: o.pred })),
      ]),
    ),
    falsePairs: Object.fromEntries(Object.entries(details).map(([k, s]) => [k, s.falsePairs])),
  };
  await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nsummary: ${join(outDir, 'summary.json')}`);

  const baselineRaw = await readText(BASELINE_PATH);
  if (baselineRaw && !updateBaseline) {
    printDeltas(perFixture, JSON.parse(baselineRaw) as BaselineFile);
  } else if (!baselineRaw && !updateBaseline) {
    console.log(`\nNo committed baseline at ${BASELINE_PATH}. Run with --update-baseline to create it.`);
  }
  if (updateBaseline) {
    const baseline: BaselineFile = {
      capturedAt: new Date().toISOString(),
      pipeline: `ppstructure medium@960+${table}+learned`,
      perFixture,
    };
    await mkdir(join(REPO_ROOT, 'test/baselines'), { recursive: true });
    await writeFile(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n', 'utf8');
    console.log(`baseline updated: ${BASELINE_PATH} (commit this so the change shows in the PR diff)`);
  }
}

await main();
