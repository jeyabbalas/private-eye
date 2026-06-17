/**
 * Postinstall (plain Node — no esbuild/tsx): replace every `node_modules/esbuild`
 * with the auto-initializing esbuild-wasm shim (vendor/esbuild-shim).
 *
 * Why: macOS Tahoe / locked-down machines can't run (or fail to resolve) the
 * native esbuild binary, which breaks Vite. The `overrides` alias in package.json
 * makes npm install esbuild-wasm in esbuild's place (so no native binary is ever
 * fetched); this script then swaps in the shim, which lazily initializes the WASM
 * service on first use (Vite never calls initialize() itself). Pure WASM runs
 * everywhere — at some build-speed cost. Native esbuild on a healthy machine
 * would be faster, but this guarantees the build works with no native binary.
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SHIM = join(ROOT, 'vendor', 'esbuild-shim');
const NM = join(ROOT, 'node_modules');

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Collect node_modules/esbuild and any one-level-nested copies. */
function esbuildDirs() {
  const out = [];
  if (!isDir(NM)) return out;
  const top = join(NM, 'esbuild');
  if (existsSync(top)) out.push(top);
  for (const name of readdirSync(NM)) {
    if (name === '.bin' || name === 'esbuild') continue;
    const base = join(NM, name);
    if (!isDir(base)) continue;
    if (name.startsWith('@')) {
      for (const sub of readdirSync(base)) {
        const e = join(base, sub, 'node_modules', 'esbuild');
        if (existsSync(e)) out.push(e);
      }
    } else {
      const e = join(base, 'node_modules', 'esbuild');
      if (existsSync(e)) out.push(e);
    }
  }
  return out;
}

if (!existsSync(SHIM)) {
  console.warn('[setup-esbuild-shim] vendor/esbuild-shim missing; skipping');
  process.exit(0);
}

const targets = esbuildDirs();
for (const dir of targets) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(SHIM, dir, { recursive: true });
}
console.log(`[setup-esbuild-shim] installed esbuild-wasm shim into ${targets.length} location(s)`);
