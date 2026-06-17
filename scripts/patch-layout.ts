/**
 * PP-DocLayoutV3 ceil_mode patch, shared by fetch-models and the patch-models
 * CLI. Emits models/layout/doclayoutv3/PP-DocLayoutV3.patched.onnx (graph
 * only — shares the 130 MB .onnx.data with the original) + PROVENANCE.json.
 *
 * ORT-web 1.26's WebGPU EP (JSEP) claims MaxPool at partition time and then
 * throws "using ceil() in shape computation is not yet supported for MaxPool"
 * on the first run (microsoft/onnxruntime#20938; JSEP fix PR #21231 closed
 * unmerged, so no version bump resolves it). The graph's single MaxPool — the
 * HGNetV2 stem pool, fed by an explicit Pad — is kernel [2,2], strides [1,1],
 * pads [0,0,0,0]: with stride 1 the ceil/floor output-shape formulas coincide
 * (ceil((x-2)/1) == floor((x-2)/1) for integer x), so flipping ceil_mode to 0
 * is bit-exact for every input size, on every EP. Proven empirically by
 * scripts/probe/layout-patch-parity.ts. Same-length varint edit (1 byte), so
 * every protobuf offset stays valid — no re-serialization.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const LAYOUT_DIR = join(ROOT, 'models/layout/doclayoutv3');
export const ORIGINAL_NAME = 'PP-DocLayoutV3.onnx';
export const PATCHED_NAME = 'PP-DocLayoutV3.patched.onnx';

// Pinned to the manifest entry for doclayoutv3-community (fetch-models.ts);
// an upstream re-export invalidates the byte-level preconditions below.
const ORIGINAL_SHA256 = 'c0721928ff08741bb208ebed539c77170db5234a68cb7e546e6cc9bc172a695b';
const PATCHED_SHA256 = 'f3ac013cce39d9f180db17d6f303b3b4892cf8acdcd8510efbc7edf0214489ae';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Find `pattern` exactly once in `buf`, else throw (wllama-patch convention:
 *  loud failure beats a patch landing on the wrong bytes). */
function findUnique(buf: Buffer, pattern: Buffer, what: string): number {
  const first = buf.indexOf(pattern);
  if (first === -1 || buf.indexOf(pattern, first + 1) !== -1) {
    throw new Error(`${what} not found (or ambiguous) in ${ORIGINAL_NAME} — re-verify the ceil_mode patch`);
  }
  return first;
}

function expectBytes(buf: Buffer, at: number, expected: number[], what: string): void {
  for (let i = 0; i < expected.length; i++) {
    if (buf[at + i] !== expected[i]) {
      throw new Error(
        `${what}: expected ${expected.map((b) => b.toString(16).padStart(2, '0')).join(' ')} at offset ${at}, ` +
          `found ${buf.subarray(at, at + expected.length).toString('hex')} — re-verify the ceil_mode patch`,
      );
    }
  }
}

/** Wire-format check that `attr` (e.g. 0a 07 "strides" 40 01 40 01) appears in
 *  the window after the ceil_mode attribute — i.e. inside the same NodeProto. */
function attrBytes(name: string, ints: number[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x0a, name.length]),
    Buffer.from(name, 'ascii'),
    Buffer.from(ints.flatMap((v) => [0x40, v])), // field 8 (ints), varint each
  ]);
}

export function ensurePatchedLayoutModel(): string | null {
  const originalPath = join(LAYOUT_DIR, ORIGINAL_NAME);
  const patchedPath = join(LAYOUT_DIR, PATCHED_NAME);
  if (!existsSync(originalPath)) {
    console.log(`skipped ceil_mode patch (${ORIGINAL_NAME} not fetched)`);
    return null;
  }
  if (existsSync(patchedPath) && sha256(readFileSync(patchedPath)) === PATCHED_SHA256) {
    console.log(`cached  layout/doclayoutv3/${PATCHED_NAME}`);
    return patchedPath;
  }

  const buf = readFileSync(originalPath);
  const origSha = sha256(buf);
  if (origSha !== ORIGINAL_SHA256) {
    throw new Error(
      `${ORIGINAL_NAME} sha256 ${origSha} != pinned ${ORIGINAL_SHA256} — ` +
        'upstream model changed; re-verify the MaxPool ceil_mode patch before re-pinning',
    );
  }

  // Locate the single ceil_mode AttributeProto and verify its wire format:
  //   2a 10            NodeProto.attribute, len 16
  //   0a 09 ceil_mode  AttributeProto.name
  //   18 01            AttributeProto.i = 1   <-- the byte to flip
  //   a0 01 02         AttributeProto.type = INT
  const s = findUnique(buf, Buffer.from('ceil_mode', 'ascii'), 'ceil_mode attribute');
  expectBytes(buf, s - 4, [0x2a, 0x10, 0x0a, 0x09], 'attribute header');
  expectBytes(buf, s + 9, [0x18, 0x01, 0xa0, 0x01, 0x02], 'attribute value/type');

  // Bind to the owning node: op_type "MaxPool" + name "node_max_pool2d" must
  // precede within the same NodeProto (64-byte window), and the bit-exactness
  // precondition strides=[1,1] (plus kernel_shape=[2,2]) must follow it.
  const before = buf.subarray(Math.max(0, s - 64), s);
  const after = buf.subarray(s, s + 96);
  const opType = Buffer.concat([Buffer.from([0x22, 0x07]), Buffer.from('MaxPool', 'ascii')]);
  const nodeName = Buffer.concat([Buffer.from([0x1a, 0x0f]), Buffer.from('node_max_pool2d', 'ascii')]);
  if (!before.includes(opType) || !before.includes(nodeName)) {
    throw new Error('ceil_mode attribute is not on MaxPool "node_max_pool2d" — re-verify the patch');
  }
  if (!after.includes(attrBytes('strides', [1, 1]))) {
    throw new Error('MaxPool strides != [1,1] — the ceil_mode flip is only bit-exact at stride 1; re-derive the patch');
  }
  if (!after.includes(attrBytes('kernel_shape', [2, 2]))) {
    throw new Error('MaxPool kernel_shape != [2,2] — graph changed; re-verify the patch');
  }

  const out = Buffer.from(buf);
  out[s + 10] = 0x00; // AttributeProto.i: 1 -> 0 (same-length varint)
  const patchedSha = sha256(out);
  if (patchedSha !== PATCHED_SHA256) {
    throw new Error(`patched sha256 ${patchedSha} != pinned ${PATCHED_SHA256} — recompute the pin if the edit changed`);
  }
  writeFileSync(patchedPath, out);
  writeFileSync(
    join(LAYOUT_DIR, 'PROVENANCE.json'),
    JSON.stringify(
      {
        source: `layout/doclayoutv3/${ORIGINAL_NAME} (Bei0001/PP-DocLayoutV3-ONNX), sha256 ${ORIGINAL_SHA256}`,
        artifact: `layout/doclayoutv3/${PATCHED_NAME}, sha256 ${PATCHED_SHA256} (same length; shares ${ORIGINAL_NAME}.data)`,
        patch:
          'MaxPool "node_max_pool2d" (HGNetV2 stem) ceil_mode 1 -> 0: one-byte same-length varint edit. ' +
          'strides=[1,1] makes ceil/floor output shapes identical for every input size, so the flip is bit-exact ' +
          '(proof: tsx scripts/probe/layout-patch-parity.ts).',
        reason:
          'ORT-web 1.26 WebGPU EP (JSEP) claims MaxPool then throws "using ceil() in shape computation is not yet ' +
          'supported" at first run (microsoft/onnxruntime#20938) with no per-node CPU fallback for claimed kernels; ' +
          'the patched graph runs on webgpu, wasm, and node-cpu alike.',
        generatedBy: 'scripts/patch/layout-maxpool.ts',
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`patched layout/doclayoutv3/${PATCHED_NAME} (ceil_mode 1 -> 0, 1 byte)`);
  return patchedPath;
}
