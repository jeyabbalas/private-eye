/**
 * Ingestion: turn uploaded Files into persisted documents + queued pages, WITHOUT
 * rendering anything. For a PDF we open it once only to read the page count, then
 * close it; the source Blob is stored and pages are re-rasterized later, one at a
 * time, at processing. Unsupported files are skipped (and reported), never thrown
 * past — adding ten files where one is junk should still enqueue the other nine.
 */
import { allDocuments, putBlob, putDocument, putPage } from './db.ts';
import { getPdfPageCount } from './pdf-raster.ts';
import type { DocKind, DocumentRecord, PageRecord } from './types.ts';

const IMAGE_MIME = /^image\/(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i;
const PDF_NAME = /\.pdf$/i;

export interface IngestedDoc {
  doc: DocumentRecord;
  pages: PageRecord[];
}

export interface IngestSummary {
  added: IngestedDoc[];
  skipped: { name: string; reason: string }[];
}

function classify(file: File): DocKind | null {
  if (file.type === 'application/pdf' || PDF_NAME.test(file.name)) return 'pdf';
  if (IMAGE_MIME.test(file.type) || (file.type === '' && /\.(png|jpe?g|webp|bmp|gif|avif|tiff?)$/i.test(file.name))) {
    return 'image';
  }
  if (/^image\//.test(file.type)) return 'image';
  return null;
}

export async function ingestFiles(files: File[]): Promise<IngestSummary> {
  const existing = await allDocuments();
  let order = existing.reduce((m, d) => Math.max(m, d.order), -1) + 1;

  const added: IngestedDoc[] = [];
  const skipped: IngestSummary['skipped'] = [];

  for (const file of files) {
    const kind = classify(file);
    if (!kind) {
      skipped.push({ name: file.name, reason: `unsupported file type (${file.type || 'unknown'})` });
      continue;
    }

    const id = crypto.randomUUID();
    const blobKey = `doc:${id}`;
    try {
      // Persist the source bytes first; if page-count probing fails we roll back.
      await putBlob(blobKey, file);
      const pageCount = kind === 'pdf' ? await getPdfPageCount(file) : 1;
      if (!(pageCount >= 1)) throw new Error('no pages found');

      const now = Date.now();
      const doc: DocumentRecord = {
        id,
        name: file.name || (kind === 'pdf' ? 'document.pdf' : 'image'),
        kind,
        mime: file.type || (kind === 'pdf' ? 'application/pdf' : 'image/*'),
        pageCount,
        blobKey,
        order: order++,
        createdAt: now,
      };
      const pages: PageRecord[] = Array.from({ length: pageCount }, (_, i) => ({
        id: `${id}:${i + 1}`,
        docId: id,
        pageNo: i + 1,
        status: 'queued',
        rasterKey: null,
        updatedAt: now,
      }));

      await putDocument(doc);
      await Promise.all(pages.map(putPage));
      added.push({ doc, pages });
    } catch (e) {
      skipped.push({ name: file.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { added, skipped };
}
