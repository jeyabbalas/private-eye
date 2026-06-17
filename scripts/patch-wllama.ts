/**
 * wllama memory-cap patch, shared by the probe driver
 * (the eval harness) and the manual-test app launcher
 * (scripts/app.ts). Extracted verbatim from the P12 driver.
 *
 * wllama's JS glue hard-caps the WASM memory at 4 GB (multithread:
 * getWasmMemory() maxBytes — an iOS-OOM workaround; single-thread: emscripten's
 * compiled-in maximum). llama.cpp b9437 (bundled in wllama 3.4.x) eagerly
 * reserves a 4.6 GB worst-case vision compute buffer for the glm4v projector
 * (hardcoded 4096-token / 3.2 Mpx limit), so GLM-OCR cannot load under 4 GB.
 * Upstream ≥ b9590 only *estimates* that worst case (963 MiB measured native),
 * so this patch becomes unnecessary at wllama's next llama.cpp sync. Until
 * then: serve a copy of the glue with the ceiling raised, plus a 1-byte raise
 * of the .wasm imported-memory max (Memory64 makes >4 GB addressable; pages
 * commit on touch only).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

const WASM_MEM_MAX_MB = 10240;
const WASM_MEM_MAX_PAGES = WASM_MEM_MAX_MB * 16; // 64 KiB pages
const PATCHED_DIR = join(ROOT, 'out/wllama-patched');

/** Same-length LEB128 patch of the module's imported-memory maximum:
 *  65536 pages (0x80 0x80 0x04) -> 163840 pages (0x80 0x80 0x0A). The wasm
 *  binary declares max 4 GB; an imported memory may not exceed the declared
 *  max, so the JS-side raise alone LinkErrors. Identical byte length keeps
 *  every section offset valid — a 1-byte surgical change. */
function patchWasmMemoryMax(wasm: Buffer): Buffer {
  const importPat = Buffer.from([0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02]); // "env" "memory" kind=2
  const first = wasm.indexOf(importPat);
  if (first === -1 || wasm.indexOf(importPat, first + 1) !== -1) {
    throw new Error('wllama.wasm memory import not found (or ambiguous) — re-verify the memory-max patch');
  }
  let p = first + importPat.length;
  const flags = wasm[p]!;
  if (flags !== 0x07) throw new Error(`unexpected memory import flags 0x${flags.toString(16)} (want 0x07 has_max|shared|memory64)`);
  p++;
  while (wasm[p]! & 0x80) p++; // skip min-pages LEB128
  p++;
  const maxBytesLeb = [0x80, 0x80, 0x04]; // 65536 pages
  const newLeb = [0x80, 0x80, 0x0a]; // 163840 pages = WASM_MEM_MAX_PAGES
  if (WASM_MEM_MAX_PAGES !== 163840) throw new Error('WASM_MEM_MAX_MB changed — recompute the LEB128 literal');
  for (let i = 0; i < 3; i++) {
    if (wasm[p + i] !== maxBytesLeb[i]) throw new Error('memory max limit is not the expected 65536-page LEB128 — re-verify patch');
  }
  const out = Buffer.from(wasm);
  for (let i = 0; i < 3; i++) out[p + i] = newLeb[i]!;
  return out;
}

export function ensurePatchedWllama(opts: { stock?: boolean } = {}): { wllamaNpm: string; patched: boolean } {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'node_modules/@wllama/wllama/package.json'), 'utf8')) as { version: string };
  const src = readFileSync(join(ROOT, 'node_modules/@wllama/wllama/esm/index.js'), 'utf8');

  // Stock pass-through (--stock-wllama): llama.cpp >= b9590 only ESTIMATES the
  // glm4v vision compute buffer (~963 MiB) instead of eagerly reserving 4.6 GB,
  // so the 4 GB WASM heap cap is never reached and the memory patch is
  // unnecessary (wllama 3.5.0 bundles b9640; GLM-OCR loads at ~2.2-2.6 GB). We
  // still stage the runtime under out/wllama-patched/ so every import site keeps
  // working unchanged.
  if (opts.stock) {
    mkdirSync(PATCHED_DIR, { recursive: true });
    writeFileSync(join(PATCHED_DIR, 'index.js'), src);
    writeFileSync(join(PATCHED_DIR, 'wllama.wasm'), readFileSync(join(ROOT, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm')));
    writeFileSync(
      join(PATCHED_DIR, 'PROVENANCE.json'),
      JSON.stringify(
        {
          source: `@wllama/wllama@${pkg.version} esm/index.js + esm/wasm/wllama.wasm`,
          patch: 'none (stock pass-through)',
          reason:
            'bundled llama.cpp only estimates the glm4v vision buffer (<1 GiB) — the 4 GB WASM heap cap is not reached, so the memory-cap patch is unnecessary',
          generatedBy: 'the eval harness (--stock-wllama)',
        },
        null,
        2,
      ) + '\n',
    );
    return { wllamaNpm: pkg.version, patched: false };
  }

  const p1 = 'let maxBytes = 4096 * 1024 * 1024;';
  const p2 = 'maximum:65536n';
  // emscripten clamps memory.grow via getHeapMax in _emscripten_resize_heap —
  // the third compiled-in 4 GB cap. (The other 4294967296 occurrences are i64
  // read/write multipliers — do not touch.)
  const p3 = 'var getHeapMax=()=>4294967296';
  if (src.split(p1).length !== 2 || src.split(p2).length !== 2 || src.split(p3).length !== 2) {
    throw new Error('wllama glue changed — re-verify the WASM memory-cap patch in the eval harness');
  }
  const patched = src
    .replace(p1, `let maxBytes = ${WASM_MEM_MAX_MB} * 1024 * 1024;`)
    .replace(p2, `maximum:${WASM_MEM_MAX_PAGES}n`)
    .replace(p3, `var getHeapMax=()=>${WASM_MEM_MAX_MB * 1024 * 1024}`);
  mkdirSync(PATCHED_DIR, { recursive: true });
  writeFileSync(join(PATCHED_DIR, 'index.js'), patched);
  const wasm = patchWasmMemoryMax(readFileSync(join(ROOT, 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm')));
  writeFileSync(join(PATCHED_DIR, 'wllama.wasm'), wasm);
  writeFileSync(
    join(PATCHED_DIR, 'PROVENANCE.json'),
    JSON.stringify(
      {
        source: `@wllama/wllama@${pkg.version} esm/index.js + esm/wasm/wllama.wasm`,
        patch:
          `WASM memory maximum 4096 MB -> ${WASM_MEM_MAX_MB} MB in three places: ` +
          'glue getWasmMemory maxBytes (multithread), glue emscripten maximum (single-thread), ' +
          'and the binary\'s imported-memory max limit (same-length LEB128, 1 byte)',
        reason:
          'llama.cpp b9437 (bundled) eagerly reserves a 4.6 GB worst-case glm4v vision buffer, over the 4 GB cap; ' +
          'upstream >= b9590 only estimates (963 MiB native) — re-evaluate at the next wllama llama.cpp sync',
        generatedBy: 'the eval harness',
      },
      null,
      2,
    ) + '\n',
  );
  return { wllamaNpm: pkg.version, patched: true };
}
