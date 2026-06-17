/**
 * Region-draw helpers (Phase 4). The overlay handles the rubber-band gesture and
 * hands back a page-pixel box; these turn that box into work:
 *
 *  - `cropRegionToBlob` cuts the box out of the page raster (at page resolution,
 *    so OCR coordinates come back in the page's own pixel space) — the small
 *    image we hand to the worker for on-demand OCR. Nothing leaves the device.
 *  - `anchorUidFor` decides where the recovered blocks splice into the working
 *    document: right after the last block that starts above the drawn region,
 *    so a missed paragraph lands roughly where it belongs in reading order.
 */
import type { BBox } from '../core/types.ts';
import type { WorkingBlock } from './corrections.ts';

/** Crop `box` out of a loaded page image into a PNG blob, at page resolution. */
export async function cropRegionToBlob(image: HTMLImageElement, box: BBox): Promise<Blob> {
  const sx = Math.max(0, Math.round(box.x0));
  const sy = Math.max(0, Math.round(box.y0));
  const sw = Math.max(1, Math.round(box.x1 - box.x0));
  const sh = Math.max(1, Math.round(box.y1 - box.y0));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);

  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('region crop failed'))), 'image/png');
  });
}

/** uid of the working block the drawn region should follow (the last block
 *  starting above the region's top), or null to splice at the very start. */
export function anchorUidFor(blocks: readonly WorkingBlock[], box: BBox): string | null {
  let anchor: string | null = null;
  for (const b of blocks) {
    if (b.box.y0 <= box.y0) anchor = b.uid;
  }
  return anchor;
}
