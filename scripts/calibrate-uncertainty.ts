/**
 * Uncertainty calibration harness for PP-OCRv6. Runs the SHARED PP-OCRv6 OCR
 * engine (det+rec — the exact stage Quick Read / Pipeline E and Deep Read /
 * Pipeline G both feed into the calibrator) over the calibration corpus, labels
 * every recognized character against ground truth, fits the isotonic
 * confidence→P(correct) map on the FIT split, then GATES it on the HELD-OUT split
 * and checks TRANSFER to the medical domain. Emits
 * out/uncertainty/<runId>/{REPORT.md, calibration.json, summary.json, reliability.svg};
 * deploys calibration.json to public/models/ppocr/ only when the gate passes.
 *
 *   Usage: node --experimental-strip-types scripts/calibrate-uncertainty.ts [--data <corpus-dir>]
 *
 * --data points at a dir with manifest.json (FUNSD/SROIE fit+held-out splits);
 * those datasets are research-licensed and live outside this repo. Absent → only
 * the always-available medical transfer set runs, no fit data exists, and the
 * harness honestly ships identity (the runtime then shows raw min/p10 only, never
 * raw softmax dressed up as calibrated). The medical transfer set is the repo's
 * own test/fixtures pathology reports.
 *
 * Why this exists: the deployed calibration.json was fit on PP-OCRv5. PP-OCRv6 is
 * a different recognizer (multilingual head, ~18.7k classes vs v5's 438), so its
 * softmax distribution differs and the v5 map is no longer valid. The "Why
 * recalibration was required" section of the report quantifies this directly:
 * deployed-v5-map-on-v6 vs raw-v6 vs refit-v6 ECE/Brier on the held-out split.
 *
 * Privacy: only aggregate metrics and a handful of isotonic breakpoints are
 * written. Recognized character text is never persisted.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { availableParallelism } from 'node:os';
import * as ort from 'onnxruntime-web';
import { createNodeContext } from '../src/adapters/node.ts';
import { PpocrEngine } from '../src/engines/ppocr/index.ts';
import { labelPage, type CorpusPage } from '../src/eval/corpus.ts';
import { loadManifest, loadMedicalTransfer } from './corpus-load.ts';
import {
  auprc,
  auroc,
  bootstrapCI,
  brier,
  fitIsotonic,
  gateSignal,
  reliability,
  reviewBudgetCurve,
  GATE,
  MIN_ERROR_EVENTS,
  type CharLabel,
  type Reliability,
} from '../src/eval/uncertainty.ts';
import { makeCalibrator, type CalibrationArtifact } from '../src/engines/ppocr/calibration.ts';

const ROOT = join(import.meta.dirname, '..');
const FIX = join(ROOT, 'test/fixtures/pathology_reports');
const GT = join(ROOT, 'test/fixtures/ground_truth');
/** The committed artifact the browser app serves (Vite copies public/ → dist/). */
const CALIB_DEPLOY = join(ROOT, 'public/models/ppocr/calibration.json');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// The shared node adapter pins wasm to 1 thread (determinism); for this batch run
// over hundreds of pages we override to the box's cores. This sets the ORT env
// singleton AFTER the adapter's import-time default, before any session is created,
// and affects only this script. Override with PPOCR_THREADS=<n>.
ort.env.wasm.numThreads = Number(process.env.PPOCR_THREADS) || Math.max(1, availableParallelism() - 2);
console.log(`ort wasm threads: ${ort.env.wasm.numThreads}`);

// ── A labeled character tagged with its provenance for slicing/bootstrapping ──
interface LabeledChar extends CharLabel {
  domain: string;
  split: CorpusPage['split'];
  doc: string;
}

const isDigit = (ch: string): boolean => ch.length === 1 && ch >= '0' && ch <= '9';
const isVisible = (ch: string): boolean => ch.trim().length > 0; // drop spaces/newlines

// ── Run the shared PP-OCRv6 engine over the corpus and collect labeled chars ──

const dataDir = arg('data');
const corpus: CorpusPage[] = [...loadManifest(dataDir), ...loadMedicalTransfer(FIX, GT)];

const byDomainSplit = new Map<string, number>();
for (const p of corpus) byDomainSplit.set(`${p.domain}/${p.split}`, (byDomainSplit.get(`${p.domain}/${p.split}`) ?? 0) + 1);

console.log(`corpus: ${corpus.length} pages`);
for (const [k, n] of [...byDomainSplit].sort()) console.log(`  ${k}: ${n}`);
if (!corpus.length) {
  console.error('No corpus pages found. Provide --data <dir> with a manifest.json, or ensure test/fixtures are present.');
  process.exit(1);
}

const ctx = createNodeContext();
const eng = new PpocrEngine();
await eng.init(ctx, { tier: 'medium' }); // the tier the app deploys

const records: LabeledChar[] = [];
let pagesRun = 0;
for (const page of corpus) {
  try {
    const image = await ctx.decodeImage(page.imagePath);
    const { result } = await eng.run(image);
    for (const l of labelPage(result.lines, page)) {
      records.push({ ...l, domain: page.domain, split: page.split, doc: page.id });
    }
    pagesRun++;
    if (pagesRun % 25 === 0) console.log(`  …${pagesRun}/${corpus.length} pages`);
  } catch (err) {
    console.error(`  ${page.id}: FAILED — ${(err as Error).message}`);
  }
}
await eng.dispose();
console.log(`labeled ${records.length} characters from ${pagesRun} pages`);

// ── Slices ────────────────────────────────────────────────────────────────────

const visible = records.filter((r) => isVisible(r.ch));
const fit = visible.filter((r) => r.split === 'fit');
const held = visible.filter((r) => r.split === 'held-out');
const transferDomains = [...new Set(visible.filter((r) => r.split === 'transfer').map((r) => r.domain))].sort();

const errCount = (rs: LabeledChar[]): number => rs.reduce((a, r) => a + (r.correct ? 0 : 1), 0);
const confs = (rs: LabeledChar[]): number[] => rs.map((r) => r.conf);
const oks = (rs: LabeledChar[]): boolean[] => rs.map((r) => r.correct);

// ── Fit isotonic on the FIT split (overall + digit-specific) ──────────────────

const fitDigit = fit.filter((r) => isDigit(r.ch));
const isoOverall = fit.length ? fitIsotonic(confs(fit), oks(fit)) : [];
const isoDigit = fitDigit.length ? fitIsotonic(confs(fitDigit), oks(fitDigit)) : [];

// Candidate artifact (used to measure post-isotonic ECE with the exact runtime map).
const candidate: CalibrationArtifact = {
  schema: 'uncertainty-calib/1',
  fittedOn: [
    `commit:${process.env.GIT_COMMIT ?? 'unknown'}`,
    'ppocrv6-medium',
    ...[...byDomainSplit.keys()].filter((k) => k.endsWith('/fit')),
  ],
  signals: isoOverall.length
    ? { ppocrCharConf: { aggregation: 'min', isotonic: isoOverall, ...(isoDigit.length ? { isotonicDigit: isoDigit } : {}) } }
    : {},
};
const calibrate = makeCalibrator(candidate).calibrate;

// ── Currently-deployed map (v5, fit on the old recognizer) for the diagnostic ──
// "What the app shows today": apply the deployed map to v6 confidences and see how
// far off it is. Discrimination (AUROC) is unchanged — the map is monotone — so we
// only report its calibration error (ECE/Brier).
function loadDeployedCalibrator(): { hasMap: boolean; calibrate: (p: number, ch: string) => number; fittedOn: string[] } {
  try {
    const art = JSON.parse(readFileSync(CALIB_DEPLOY, 'utf8')) as CalibrationArtifact;
    const c = makeCalibrator(art);
    return { hasMap: c.mode === 'isotonic', calibrate: c.calibrate, fittedOn: art.fittedOn ?? [] };
  } catch {
    return { hasMap: false, calibrate: (p) => p, fittedOn: [] };
  }
}
const deployed = loadDeployedCalibrator();

// ── Held-out metrics: raw vs calibrated, AUROC with cluster-bootstrap CI ───────

const heldErrors = errCount(held);
const relRaw: Reliability = reliability(confs(held), oks(held));
const relCal: Reliability = reliability(held.map((r) => calibrate(r.conf, r.ch)), oks(held));
const relDeployed: Reliability = deployed.hasMap
  ? reliability(held.map((r) => deployed.calibrate(r.conf, r.ch)), oks(held))
  : relRaw; // no prior map ⇒ the app would already be on identity (== raw)
// Brier — a strictly proper score (calibration + discrimination in one number).
// Isotonic is monotone (AUROC-preserving), so the raw→cal drop isolates the
// calibration gain. brierSkill = fractional reduction vs the raw model.
const brierRaw = held.length ? brier(confs(held), oks(held)) : 0;
const brierCal = held.length ? brier(held.map((r) => calibrate(r.conf, r.ch)), oks(held)) : 0;
const brierDeployed = held.length && deployed.hasMap ? brier(held.map((r) => deployed.calibrate(r.conf, r.ch)), oks(held)) : brierRaw;
const brierSkill = brierRaw > 0 ? 1 - brierCal / brierRaw : 0;
const heldGroups = [...groupBy(held, (r) => r.doc).values()];
const aurocCI = held.length ? bootstrapCI(heldGroups, (its) => auroc(confs(its), oks(its)), { B: 1000 }) : { point: 0.5, lo: 0, hi: 1 };
const heldAuprc = held.length ? auprc(confs(held), oks(held)) : 0;
const heldBudget = held.length ? reviewBudgetCurve(confs(held), oks(held)).auc : 0;

// Digit slice (held-out) — the safety-critical numeric class, reported separately.
const heldDigit = held.filter((r) => isDigit(r.ch));
const digitAurocPoint = heldDigit.length ? auroc(confs(heldDigit), oks(heldDigit)) : 0.5;

// Transfer per domain (medical): point AUROC + post-isotonic ECE.
const transfer = transferDomains.map((d) => {
  const rs = visible.filter((r) => r.split === 'transfer' && r.domain === d);
  return {
    domain: d,
    n: rs.length,
    errors: errCount(rs),
    auroc: rs.length ? auroc(confs(rs), oks(rs)) : 0.5,
    eceCal: rs.length ? reliability(rs.map((r) => calibrate(r.conf, r.ch)), oks(rs)).ece : 0,
    brierRaw: rs.length ? brier(confs(rs), oks(rs)) : 0,
    brierCal: rs.length ? brier(rs.map((r) => calibrate(r.conf, r.ch)), oks(rs)) : 0,
  };
});

// ── Gate ──────────────────────────────────────────────────────────────────────

const preReasons: string[] = [];
if (!fit.length) preReasons.push('no FIT data — cannot fit an isotonic map (provide --data with a fit split)');
if (!held.length) preReasons.push('no HELD-OUT data — the gate has nothing to validate against');

const evaluated = fit.length > 0 && held.length > 0;
const gate = evaluated
  ? gateSignal({
      heldOutAuroc: aurocCI,
      eceRaw: relRaw.ece,
      eceCal: relCal.ece,
      transferAuroc: transfer.map((t) => t.auroc),
      nErrors: heldErrors,
    })
  : { ship: false, reasons: preReasons };

const ship = gate.ship;
const artifact: CalibrationArtifact = ship ? candidate : { schema: 'uncertainty-calib/1', signals: {} };

// ── Write report + artifact ────────────────────────────────────────────────────

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(ROOT, 'out/uncertainty', runId);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'calibration.json'), JSON.stringify(artifact, null, 2));
writeFileSync(join(outDir, 'reliability.svg'), reliabilitySvg(relRaw, relCal));
writeFileSync(join(outDir, 'REPORT.md'), renderReport());
writeFileSync(
  join(outDir, 'summary.json'),
  JSON.stringify(
    {
      runId,
      model: 'PP-OCRv6_medium',
      corpus: Object.fromEntries(byDomainSplit),
      chars: { total: records.length, visible: visible.length, fit: fit.length, held: held.length },
      deployedBeforeRun: { hasMap: deployed.hasMap, fittedOn: deployed.fittedOn, eceOnV6: relDeployed.ece, brierOnV6: brierDeployed },
      heldOut: { auroc: aurocCI, auprc: heldAuprc, reviewAuc: heldBudget, eceRaw: relRaw.ece, eceCal: relCal.ece, brierRaw, brierCal, brierSkill, errors: heldErrors, digitAuroc: digitAurocPoint },
      transfer,
      gate: { ship, reasons: gate.reasons },
    },
    null,
    2,
  ),
);

// Deploy: only ever touch the committed artifact when a real evaluation happened.
//  - PASS  → write the refit v6 map.
//  - DROP after a real eval → write empty-signals (identity). The deployed map is a
//    STALE v5 map; leaving it would keep presenting a wrong map as calibrated, so
//    the honest action is to replace it with identity (runtime shows raw min/p10).
//  - No eval (missing --data) → leave the deployed file untouched; just report.
if (ship) {
  writeFileSync(CALIB_DEPLOY, JSON.stringify(artifact, null, 2));
  console.log(`\n✅ SHIP — deployed v6 calibration.json → ${CALIB_DEPLOY}`);
  console.log('   Run `npm run build` to copy public/ → dist/ for the browser app.');
} else if (evaluated) {
  writeFileSync(CALIB_DEPLOY, JSON.stringify(artifact, null, 2)); // empty-signals → identity
  console.log(`\n⛔ DROP (identity) — ${gate.reasons.join('; ')}`);
  console.log(`   Replaced the stale map at ${CALIB_DEPLOY} with empty-signals → runtime uses identity (raw min/p10).`);
  console.log('   Run `npm run build` to propagate to dist/.');
} else {
  console.log(`\n⛔ DROP (identity) — ${gate.reasons.join('; ')}`);
  console.log(`   No evaluation performed; left ${CALIB_DEPLOY} untouched. Pass --data <corpus> to fit and gate.`);
}
console.log(`wrote ${join(outDir, 'REPORT.md')}`);

// ── Helpers ─────────────────────────────────────────────────────────────────

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k) ?? [];
    arr.push(it);
    m.set(k, arr);
  }
  return m;
}

function f3(x: number): string {
  return x.toFixed(3);
}
function f4(x: number): string {
  return x.toFixed(4); // Brier is ~0.02 here; 4 dp so its small-but-real drop is visible.
}
function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function reliabilityTable(r: Reliability): string {
  const head = '| bin | n | mean conf | accuracy | gap |\n| --- | --- | --- | --- | --- |';
  const rows = r.bins
    .filter((b) => b.n > 0)
    .map((b) => `| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${f3(b.meanScore)} | ${f3(b.meanLabel)} | ${f3(Math.abs(b.meanScore - b.meanLabel))} |`);
  return [head, ...rows].join('\n');
}

function renderReport(): string {
  const L: string[] = [];
  L.push(`# Uncertainty calibration — \`ppocrCharConf\` (PP-OCRv6 medium per-char confidence)`);
  L.push('');
  L.push(`Run \`${runId}\`. The shared PP-OCRv6 det+rec engine over the calibration corpus. Fit on the FIT split, gated on HELD-OUT, transfer to medical. One per-character map serves both Quick Read (Pipeline E) and Deep Read (Pipeline G).`);
  L.push('');
  L.push(`**Decision: ${ship ? '✅ SHIP (isotonic)' : '⛔ DROP (ship identity)'}**`);
  if (gate.reasons.length) L.push(...gate.reasons.map((r) => `- ${r}`));
  L.push('');
  L.push(`## Why recalibration was required (held-out split)`);
  L.push('');
  L.push(
    'The deployed `calibration.json` was fit on **PP-OCRv5**; the app now runs **PP-OCRv6 medium**. A monotone map preserves ranking, so AUROC is identical across all three columns below — the difference is purely **calibration quality** (does a stated probability match observed accuracy). ECE/Brier lower is better.',
  );
  L.push('');
  L.push('| held-out P(correct) source | ECE | Brier |');
  L.push('| --- | --- | --- |');
  L.push(
    `| deployed v5 map applied to v6 (what the app shows today) | ${deployed.hasMap ? f3(relDeployed.ece) : 'n/a (no prior map → identity)'} | ${deployed.hasMap ? f4(brierDeployed) : 'n/a'} |`,
  );
  L.push(`| raw v6 softmax, no calibration | ${f3(relRaw.ece)} | ${f4(brierRaw)} |`);
  L.push(`| **refit v6 isotonic (this run)** | **${f3(relCal.ece)}** | **${f4(brierCal)}** |`);
  if (deployed.hasMap) L.push('', `Deployed map provenance — \`fittedOn\`: ${deployed.fittedOn.join(', ') || '(none)'}.`);
  L.push('');
  L.push(`## Corpus`);
  L.push('| domain/split | pages |\n| --- | --- |');
  for (const [k, n] of [...byDomainSplit].sort()) L.push(`| ${k} | ${n} |`);
  L.push('');
  L.push(`Characters: ${records.length} total, ${visible.length} visible (spaces dropped). Fit ${fit.length}, held-out ${held.length} (${heldErrors} errors).`);
  L.push('');
  L.push(`## Gate (held-out split)`);
  L.push('| metric | value | threshold | pass |');
  L.push('| --- | --- | --- | --- |');
  L.push(`| AUROC | ${f3(aurocCI.point)} (95% CI ${f3(aurocCI.lo)}–${f3(aurocCI.hi)}) | ≥ ${GATE.MIN_AUROC}, CI lower > ${GATE.MIN_AUROC_CI_LOWER} | ${aurocCI.point >= GATE.MIN_AUROC && aurocCI.lo > GATE.MIN_AUROC_CI_LOWER ? '✅' : '❌'} |`);
  L.push(`| ECE raw → calibrated | ${f3(relRaw.ece)} → ${f3(relCal.ece)} | ≤ ${GATE.MAX_ECE} and improved | ${relCal.ece <= GATE.MAX_ECE && relCal.ece <= relRaw.ece + 1e-9 ? '✅' : '❌'} |`);
  L.push(`| Brier raw → calibrated | ${f4(brierRaw)} → ${f4(brierCal)} (↓ ${pct(brierSkill)}) | improved | ${brierCal <= brierRaw + 1e-9 ? '✅' : '❌'} |`);
  L.push(`| held-out error events | ${heldErrors} | ≥ ${MIN_ERROR_EVENTS} | ${heldErrors >= MIN_ERROR_EVENTS ? '✅' : '❌'} |`);
  L.push(`| AUPRC (error detection) | ${f3(heldAuprc)} | — (report) | |`);
  L.push(`| review-budget AUC | ${f3(heldBudget)} | — (report) | |`);
  L.push(`| digit-slice AUROC | ${f3(digitAurocPoint)} | — (report) | |`);
  L.push('');
  L.push(
    `**Brier score** is a strictly proper scoring rule — mean squared error of P(correct) against the 0/1 outcome — so it grades calibration *and* discrimination at once (0 = perfect, 0.25 = always guessing 0.5). The isotonic map is monotone and therefore AUROC-preserving, so the **${pct(brierSkill)} Brier reduction is purely the calibration gain**: the same rankings, expressed as more honest probabilities. ECE and Brier both improving is the gate's evidence that the map is better, not just different.`,
  );
  L.push('');
  L.push(
    `The *absolute* Brier is small and its reduction modest because the score is dominated by the large already-confident-and-correct majority of glyphs; the calibration headroom — and the practical gain — concentrates in the low/mid-confidence characters that actually get reviewed, where ECE shrinks (${f3(relRaw.ece)} → ${f3(relCal.ece)}) and the reliability bins below straighten out. Read Brier alongside the reliability tables, not on its own.`,
  );
  L.push('');
  L.push(`### Reliability — raw`);
  L.push(reliabilityTable(relRaw));
  L.push('');
  L.push(`### Reliability — after isotonic`);
  L.push(reliabilityTable(relCal));
  L.push('');
  L.push(`### Calibration plot`);
  L.push('');
  L.push('![Reliability diagram — raw vs isotonic-calibrated](reliability.svg)');
  L.push('');
  L.push(
    'The dashed diagonal is perfect calibration. Each point is one confidence bin (x = mean predicted confidence, y = observed accuracy; marker size ∝ log count). The **raw** curve bows off the diagonal while the **calibrated** curve is pulled onto it. That movement toward the diagonal *is* the ECE/Brier reduction, made visible. The same plot in text (for terminals):',
  );
  L.push('');
  L.push('```');
  L.push(...reliabilityAsciiPlot(relRaw, relCal));
  L.push('```');
  L.push('');
  L.push(`## Transfer (no AUROC may collapse below ${GATE.MIN_TRANSFER_AUROC})`);
  if (transfer.length) {
    L.push('| domain | chars | errors | AUROC | ECE (cal) | Brier raw→cal | ok |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const t of transfer)
      L.push(
        `| ${t.domain} | ${t.n} | ${t.errors} | ${f3(t.auroc)} | ${f3(t.eceCal)} | ${f4(t.brierRaw)} → ${f4(t.brierCal)} | ${t.auroc >= GATE.MIN_TRANSFER_AUROC ? '✅' : '❌'} |`,
      );
  } else {
    L.push('_No transfer pages._');
  }
  L.push('');
  L.push(`## Other uncertainty signals`);
  L.push('- **Layout coverage gaps** (orphan OCR lines outside all regions) and **cross-model numeric disagreement** (Pipeline G) are *cross-model agreement* signals, not calibratable probabilities. They are emitted unconditionally by the pipelines as evidence (a flag + both readings), so they carry no isotonic map to gate here. This artifact governs only the per-character confidence map.');
  L.push('- `fittedOn`: ' + (candidate.fittedOn ?? []).join(', '));
  L.push('');
  L.push(...deploymentSection());
  return L.join('\n') + '\n';
}

/** How to deploy E and G with these uncertainty estimates, in private-eye terms. */
function deploymentSection(): string[] {
  const D: string[] = [];
  D.push(`## Deploying Quick Read (E) & Deep Read (G) with uncertainty`);
  D.push('');
  D.push(
    ship
      ? '_This run SHIPPED: `calibration.json` was written to `public/models/ppocr/calibration.json`. Run `npm run build` to copy `public/` → `dist/`._'
      : evaluated
        ? '_This run DROPPED (identity): the stale map at `public/models/ppocr/calibration.json` was replaced with empty-signals so the runtime uses identity. Fix the gate failures above, re-run, then `npm run build`._'
        : '_This run DROPPED (identity) with NO evaluation (no `--data`): the deployed artifact was left untouched. Pass `--data <corpus>` to fit and gate._',
  );
  D.push('');
  D.push('### 1. The artifact');
  D.push('- The only thing that ships is `public/models/ppocr/calibration.json` (~20 KB) — a handful of isotonic breakpoints (overall + digit-specific) plus `fittedOn` provenance. **No dataset text or PHI** is in it.');
  D.push('- Regenerate any time with `npm run calibrate -- --data <corpus-dir>`. It deploys on a PASS, and on a DROP-after-eval it replaces the file with empty-signals (honest identity).');
  D.push('- It is served same-origin by Vite alongside the OCR weights and resolved by `loadCalibration` (`src/engines/ppocr/calibration.ts`) at the URL `ppocr/calibration.json`.');
  D.push('');
  D.push('### 2. Make the artifact reachable by the runtime');
  D.push('- **Browser app**: `public/models/ppocr/calibration.json` is copied into `dist/models/ppocr/` by `npm run build` and served at the same path as the model weights. That single file is the entire deployment step.');
  D.push('- No code change is required to *enable* calibration: both pipelines already call `loadCalibration(ctx)` at init. Present + non-empty signal → calibrated; absent/empty/unreadable → identity.');
  D.push('');
  D.push('### 3. What each pipeline emits on `PageRun.uncertainty` (`UncertaintyLayer`, schema `uncertainty/1`)');
  D.push("- **`calibration`**: `'isotonic'` when the map loaded, else `'identity'`. **Consumers must read this field** and never present identity values as calibrated probabilities (show raw min/p10 as triage hints only).");
  D.push('- **Quick Read / Pipeline E** — primary signal is per-character confidence: `lines[].chars[]` carry calibrated `conf = P(correct)`; highlight glyphs below the review threshold τ.');
  D.push('- **Deep Read / Pipeline G** — its OCR context lines are calibrated by the **same** per-char map on the live path; cross-model numeric disagreements surface both readings regardless.');
  D.push('');
  D.push('### 4. Honest-by-default contract');
  D.push('- A DROPPED or missing signal yields no calibrated output rather than a misleading one — `loadCalibration` falls back to identity and the layer says so. This is the mechanical form of the project rule: *no estimate over an unhelpful one*.');
  D.push('- Provenance: check `fittedOn` (model + corpus + commit) before trusting a deployed map; re-run the harness when the OCR model or its preprocessing changes (as here, on the v5→v6 upgrade).');
  return D;
}

// ── Reliability diagram (the calibration plot) ───────────────────────────────

/** Per-bin points (x = mean confidence, y = observed accuracy), sorted along x. */
function relPoints(r: Reliability): { x: number; y: number; n: number }[] {
  return r.bins.filter((b) => b.n > 0).map((b) => ({ x: b.meanScore, y: b.meanLabel, n: b.n })).sort((a, b) => a.x - b.x);
}

/**
 * Reliability diagram as a standalone SVG (pure string — no chart dependency).
 * Diagonal = perfect calibration; the raw curve bows off it, the calibrated curve
 * is pulled onto it. This is the visual form of the ECE/Brier argument.
 */
function reliabilitySvg(raw: Reliability, cal: Reliability): string {
  const W = 470, H = 430, ML = 60, MR = 18, MT = 30, MB = 54;
  const pw = W - ML - MR, ph = H - MT - MB;
  const X = (v: number): string => (ML + v * pw).toFixed(1);
  const Y = (v: number): string => (MT + (1 - v) * ph).toFixed(1);
  const RAW = '#d9534f', CAL = '#2e7d32', GRID = '#eaeaea', AX = '#999';
  const poly = (r: Reliability, color: string): string =>
    `<polyline points="${relPoints(r).map((p) => `${X(p.x)},${Y(p.y)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.8"/>`;
  const dots = (r: Reliability, color: string): string =>
    relPoints(r)
      .map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="${(2 + Math.min(5, Math.log10(p.n + 1))).toFixed(1)}" fill="${color}" fill-opacity="0.85"/>`)
      .join('');
  const grid: string[] = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    grid.push(`<line x1="${X(t)}" y1="${Y(0)}" x2="${X(t)}" y2="${Y(1)}" stroke="${GRID}"/>`);
    grid.push(`<line x1="${X(0)}" y1="${Y(t)}" x2="${X(1)}" y2="${Y(t)}" stroke="${GRID}"/>`);
    grid.push(`<text x="${X(t)}" y="${(MT + ph + 16).toFixed(1)}" font-size="10" text-anchor="middle" fill="#666">${t.toFixed(2)}</text>`);
    grid.push(`<text x="${(ML - 8).toFixed(1)}" y="${(Number(Y(t)) + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="#666">${t.toFixed(2)}</text>`);
  }
  const cy = (MT + ph / 2).toFixed(1);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="sans-serif">`,
    `<rect width="${W}" height="${H}" fill="white"/>`,
    `<text x="${W / 2}" y="18" font-size="13" text-anchor="middle" fill="#222">Reliability diagram — raw vs isotonic-calibrated (PP-OCRv6)</text>`,
    ...grid,
    `<rect x="${ML}" y="${MT}" width="${pw}" height="${ph}" fill="none" stroke="${AX}"/>`,
    `<line x1="${X(0)}" y1="${Y(0)}" x2="${X(1)}" y2="${Y(1)}" stroke="${AX}" stroke-dasharray="4 3"/>`,
    poly(raw, RAW),
    dots(raw, RAW),
    poly(cal, CAL),
    dots(cal, CAL),
    `<text x="${(ML + pw / 2).toFixed(1)}" y="${H - 8}" font-size="11" text-anchor="middle" fill="#333">mean predicted confidence</text>`,
    `<text x="16" y="${cy}" font-size="11" text-anchor="middle" fill="#333" transform="rotate(-90 16 ${cy})">observed accuracy</text>`,
    `<g transform="translate(${ML + 14},${MT + 12})">`,
    `<rect x="-8" y="-13" width="186" height="56" fill="white" fill-opacity="0.82" stroke="#ddd"/>`,
    `<line x1="0" y1="0" x2="18" y2="0" stroke="${RAW}" stroke-width="2"/><text x="24" y="3" font-size="10" fill="#333">raw (ECE ${raw.ece.toFixed(3)})</text>`,
    `<line x1="0" y1="17" x2="18" y2="17" stroke="${CAL}" stroke-width="2"/><text x="24" y="20" font-size="10" fill="#333">calibrated (ECE ${cal.ece.toFixed(3)})</text>`,
    `<line x1="0" y1="34" x2="18" y2="34" stroke="${AX}" stroke-dasharray="4 3"/><text x="24" y="37" font-size="10" fill="#999">perfect (y = x)</text>`,
    `</g>`,
    `</svg>`,
  ].join('\n');
}

/** Same reliability diagram rendered in monospace text, so the report is legible
 *  in a terminal / plain-text viewer where the SVG won't display. */
function reliabilityAsciiPlot(raw: Reliability, cal: Reliability): string[] {
  const W = 41, Hh = 19, PRE = 5;
  const grid: string[][] = Array.from({ length: Hh }, () => Array.from({ length: W }, () => ' '));
  const col = (v: number): number => Math.max(0, Math.min(W - 1, Math.round(v * (W - 1))));
  const row = (v: number): number => Math.max(0, Math.min(Hh - 1, Math.round((1 - v) * (Hh - 1))));
  for (let c = 0; c < W; c++) {
    const r = row(c / (W - 1));
    if (grid[r]![c] === ' ') grid[r]![c] = '·';
  }
  for (const p of relPoints(raw)) grid[row(p.y)]![col(p.x)] = 'R';
  for (const p of relPoints(cal)) {
    const r = row(p.y), c = col(p.x);
    grid[r]![c] = grid[r]![c] === 'R' ? '*' : 'C';
  }
  const lines: string[] = ['  observed accuracy'];
  for (let r = 0; r < Hh; r++) {
    const label = r % 3 === 0 ? (1 - r / (Hh - 1)).toFixed(2) : '';
    lines.push(`${label.padStart(4)} |${grid[r]!.join('')}`);
  }
  lines.push(`${' '.repeat(PRE)}+${'-'.repeat(W)}`);
  const axis = Array.from({ length: PRE + 1 + W + 3 }, () => ' ');
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const s = t.toFixed(2);
    const center = PRE + 1 + col(t);
    for (let i = 0; i < s.length; i++) {
      const pos = center - Math.floor(s.length / 2) + i;
      if (pos >= 0 && pos < axis.length) axis[pos] = s[i]!;
    }
  }
  lines.push(axis.join('').replace(/\s+$/, ''));
  lines.push(`${' '.repeat(PRE + 1)}mean predicted confidence`);
  lines.push('');
  lines.push('  legend:  · perfect (y=x)   R raw   C calibrated   * both coincide');
  return lines;
}
