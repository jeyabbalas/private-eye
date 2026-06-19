/**
 * Carousel thumbnails. The page raster (an image Blob, or a PDF page rasterized on
 * demand) is downscaled to a small PNG and handed back as an object URL the tile's
 * <img> can show. Kept tiny and lazy: the carousel only asks for a thumbnail when a
 * tile scrolls into view, and caches the result, so a long document doesn't
 * rasterize every page up front.
 */

/** Downscale an image blob to a thumbnail PNG object URL (longest edge ≤ maxEdge).
 *  The caller owns the returned URL and must revokeObjectURL it when done. */
export async function makeThumbUrl(source: Blob, maxEdge = 80): Promise<string> {
  const bmp = await createImageBitmap(source);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('thumbnail 2d context unavailable');
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('thumbnail encode failed'))), 'image/png');
    });
    return URL.createObjectURL(blob);
  } finally {
    bmp.close();
  }
}
