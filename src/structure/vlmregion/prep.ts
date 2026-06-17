/**
 * Uniform crop pre-policy (promptRev-relevant), TS port of bakeoff/lib/rails.py
 * prep_image — kept in sync BY HAND with the Python side:
 *   1. white-matte any transparency (PIL "RGB convert with white background");
 *   2. tiny crops (min side < 56 px) upscale by the smallest integer factor
 *      reaching >= 112 px on the short side;
 *   3. extreme aspect (> 50:1) pads the short axis with white;
 *   4. never downscale.
 * Known divergence: the upscale resampler is resizeBilinear here vs PIL LANCZOS
 * (policy identical, resampler differs); affects only crops with min side
 * < 56 px and is quantified against the native oracle in the P12 spike.
 */
import { resizeBilinear } from '../../core/imageops.ts';
import type { RasterImage } from '../../core/types.ts';

export function prepCropPolicy(img: RasterImage): { img: RasterImage; modified: boolean } {
  let out = img;
  let modified = false;

  // 1. White matte (RGBA crops from PNG decode are usually opaque — no-op then).
  const d = out.data;
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] !== 255) {
      hasAlpha = true;
      break;
    }
  }
  if (hasAlpha) {
    const nd = new Uint8ClampedArray(d.length);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3]! / 255;
      nd[i] = d[i]! * a + 255 * (1 - a);
      nd[i + 1] = d[i + 1]! * a + 255 * (1 - a);
      nd[i + 2] = d[i + 2]! * a + 255 * (1 - a);
      nd[i + 3] = 255;
    }
    out = { data: nd, width: out.width, height: out.height };
    modified = true;
  }

  // 2. Tiny-crop integer upscale.
  let w = out.width;
  let h = out.height;
  const short0 = Math.min(w, h);
  if (short0 > 0 && short0 < 56) {
    const f = Math.ceil(112 / short0);
    out = resizeBilinear(out, w * f, h * f);
    w = out.width;
    h = out.height;
    modified = true;
  }

  // 3. Extreme-aspect white pad (paste at (0,0), Python canvas semantics).
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (short > 0 && long / short > 50) {
    const targetShort = Math.ceil(long / 50);
    const cw = w >= h ? w : Math.max(w, targetShort);
    const ch = w >= h ? Math.max(h, targetShort) : h;
    const nd = new Uint8ClampedArray(cw * ch * 4).fill(255);
    for (let y = 0; y < h; y++) {
      nd.set(out.data.subarray(y * w * 4, (y + 1) * w * 4), y * cw * 4);
    }
    out = { data: nd, width: cw, height: ch };
    modified = true;
  }

  return { img: out, modified };
}
