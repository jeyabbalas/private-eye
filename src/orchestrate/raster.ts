/**
 * Resolve the displayable raster for a page from persisted SOURCES. Image
 * documents return their original Blob; PDF pages are rasterized on demand from
 * the stored PDF — reproducibly, at the page's persisted `renderScale` when
 * known, so a preview/overlay aligns pixel-for-pixel with what was read.
 */
import { getBlob } from './db.ts';
import { rasterizePdfPage } from './pdf-raster.ts';
import { decodeError } from '../runtime/errors.ts';
import type { DocumentRecord, PageRecord } from './types.ts';

export async function pageImageBlob(doc: DocumentRecord, page: PageRecord): Promise<Blob> {
  const src = await getBlob(doc.blobKey);
  if (!src) throw decodeError('source file is missing from storage', { blobKey: doc.blobKey });
  if (doc.kind !== 'pdf') return src;
  const { blob } = await rasterizePdfPage(src, page.pageNo, page.renderScale);
  return blob;
}
