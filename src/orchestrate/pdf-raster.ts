/**
 * PDF → page raster, one page at a time. The plan's memory rule: at ingestion we
 * only read the page count and close the document (render nothing); at processing
 * (or preview) we render exactly the one page we need, then destroy the document.
 *
 * pdf.js parses in its OWN worker (configured below), so the only main-thread
 * cost here is the canvas raster + PNG encode of a single page — modest, and
 * confined to one page at a time.
 *
 * Scale is chosen by a PIXEL BUDGET (≈2000 px long edge, ~165–200 DPI) rather
 * than a fixed factor, clamped, with a hard megapixel cap so a poster-sized page
 * can't blow up the heap. The scale used is returned so callers can persist it
 * and reproduce identical pixels (and thus pixel-aligned boxes) later.
 */
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { decodeError } from '../runtime/errors.ts';

// Vite fingerprints this under `base`; pdf.js loads its parser worker from here.
GlobalWorkerOptions.workerSrc = workerUrl;

const TARGET_LONG_EDGE_PX = 2000;
const MAX_MEGAPIXELS = 25;
const MIN_SCALE = 1.0;
const MAX_SCALE = 3.0;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

async function openPdf(pdf: Blob): Promise<PDFDocumentProxy> {
  // A fresh byte copy each call: getDocument transfers/detaches the buffer.
  const data = new Uint8Array(await pdf.arrayBuffer());
  try {
    return await getDocument({ data, isEvalSupported: false }).promise;
  } catch (e) {
    throw decodeError('could not open PDF', { name: (pdf as File).name }, e);
  }
}

/** Read a PDF's page count, then close it (renders nothing). */
export async function getPdfPageCount(pdf: Blob): Promise<number> {
  const doc = await openPdf(pdf);
  try {
    return doc.numPages;
  } finally {
    void doc.destroy();
  }
}

export interface RasterResult {
  blob: Blob;
  width: number;
  height: number;
  /** The scale actually used (persist to reproduce identical pixels). */
  scale: number;
}

/**
 * Rasterize a single 1-based page to a PNG Blob. When `fixedScale` is given (a
 * previously-persisted `renderScale`) it is used verbatim for deterministic
 * reproduction; otherwise the pixel-budget scale is computed.
 */
export async function rasterizePdfPage(pdf: Blob, pageNo: number, fixedScale?: number): Promise<RasterResult> {
  const doc = await openPdf(pdf);
  try {
    if (pageNo < 1 || pageNo > doc.numPages) {
      throw decodeError(`page ${pageNo} out of range (1..${doc.numPages})`);
    }
    const page = await doc.getPage(pageNo);

    let scale = fixedScale ?? pickScale(page.getViewport({ scale: 1 }));
    const viewport = page.getViewport({ scale });
    const width = Math.max(1, Math.ceil(viewport.width));
    const height = Math.max(1, Math.ceil(viewport.height));

    const canvas = new OffscreenCanvas(width, height);
    const cctx = canvas.getContext('2d', { alpha: false });
    if (!cctx) throw decodeError('could not acquire a 2D canvas context for PDF rendering');
    // Flatten transparency onto white "paper" so the OCR sees a clean scan.
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, width, height);

    await page.render({
      // OffscreenCanvas 2D context is API-compatible with pdf.js's expectations.
      canvasContext: cctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;
    page.cleanup();

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { blob, width, height, scale };
  } finally {
    void doc.destroy();
  }
}

/** Pixel-budget scale: aim for ~2000 px on the long edge, clamped, MP-capped. */
function pickScale(base: { width: number; height: number }): number {
  const longEdge = Math.max(base.width, base.height) || 1;
  let scale = clamp(TARGET_LONG_EDGE_PX / longEdge, MIN_SCALE, MAX_SCALE);
  const megapixels = (base.width * scale * (base.height * scale)) / 1e6;
  if (megapixels > MAX_MEGAPIXELS) scale *= Math.sqrt(MAX_MEGAPIXELS / megapixels);
  return scale;
}
