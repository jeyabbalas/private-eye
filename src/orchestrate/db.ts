/**
 * IndexedDB persistence (via `idb`, a tiny Promise wrapper). One database holds
 * everything needed to restore a session after a reload: the original file
 * Blobs, per-page status, read results, and corrections. Stores keep SOURCES,
 * not derivatives (see types.ts). All access goes through the typed helpers
 * below so the rest of the app never touches a raw transaction.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  CorrectionRecord,
  DocId,
  DocumentRecord,
  PageId,
  PageRecord,
  PageStatus,
  ResultRecord,
} from './types.ts';

interface PrivateEyeDB extends DBSchema {
  documents: { key: DocId; value: DocumentRecord; indexes: { byOrder: number } };
  pages: { key: PageId; value: PageRecord; indexes: { byDoc: DocId; byStatus: PageStatus } };
  results: { key: PageId; value: ResultRecord; indexes: { byDoc: DocId } };
  corrections: { key: PageId; value: CorrectionRecord; indexes: { byDoc: DocId } };
  /** Out-of-line keyed blob store: source files (`doc:<id>`) and optional rasters. */
  blobs: { key: string; value: Blob };
}

const DB_NAME = 'private-eye';
const DB_VERSION = 1;

let dbp: Promise<IDBPDatabase<PrivateEyeDB>> | null = null;

function db(): Promise<IDBPDatabase<PrivateEyeDB>> {
  return (dbp ??= openDB<PrivateEyeDB>(DB_NAME, DB_VERSION, {
    upgrade(d) {
      const docs = d.createObjectStore('documents', { keyPath: 'id' });
      docs.createIndex('byOrder', 'order');

      const pages = d.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('byDoc', 'docId');
      pages.createIndex('byStatus', 'status');

      const results = d.createObjectStore('results', { keyPath: 'pageId' });
      results.createIndex('byDoc', 'docId');

      const corrections = d.createObjectStore('corrections', { keyPath: 'pageId' });
      corrections.createIndex('byDoc', 'docId');

      d.createObjectStore('blobs');
    },
  }));
}

// ---------- documents ----------

export async function putDocument(doc: DocumentRecord): Promise<void> {
  await (await db()).put('documents', doc);
}

export async function getDocument(id: DocId): Promise<DocumentRecord | undefined> {
  return (await db()).get('documents', id);
}

/** All documents in display order. */
export async function allDocuments(): Promise<DocumentRecord[]> {
  return (await db()).getAllFromIndex('documents', 'byOrder');
}

// ---------- pages ----------

export async function putPage(page: PageRecord): Promise<void> {
  await (await db()).put('pages', page);
}

export async function getPage(id: PageId): Promise<PageRecord | undefined> {
  return (await db()).get('pages', id);
}

/** Pages of a document, sorted by page number. */
export async function pagesByDocument(docId: DocId): Promise<PageRecord[]> {
  const pages = await (await db()).getAllFromIndex('pages', 'byDoc', docId);
  return pages.sort((a, b) => a.pageNo - b.pageNo);
}

export async function pagesByStatus(status: PageStatus): Promise<PageRecord[]> {
  return (await db()).getAllFromIndex('pages', 'byStatus', status);
}

// ---------- results ----------

export async function putResult(result: ResultRecord): Promise<void> {
  await (await db()).put('results', result);
}

export async function getResult(pageId: PageId): Promise<ResultRecord | undefined> {
  return (await db()).get('results', pageId);
}

// ---------- corrections ----------

export async function putCorrection(correction: CorrectionRecord): Promise<void> {
  await (await db()).put('corrections', correction);
}

export async function getCorrection(pageId: PageId): Promise<CorrectionRecord | undefined> {
  return (await db()).get('corrections', pageId);
}

// ---------- blobs ----------

export async function putBlob(key: string, blob: Blob): Promise<void> {
  await (await db()).put('blobs', blob, key);
}

export async function getBlob(key: string): Promise<Blob | undefined> {
  return (await db()).get('blobs', key);
}

// ---------- cascade delete ----------

/** Remove a document and everything derived from it (pages, results, corrections,
 *  source + any raster blobs) in a single transaction. */
export async function deleteDocumentCascade(docId: DocId): Promise<void> {
  const d = await db();
  const doc = await d.get('documents', docId);
  const pages = await d.getAllFromIndex('pages', 'byDoc', docId);

  const tx = d.transaction(['documents', 'pages', 'results', 'corrections', 'blobs'], 'readwrite');
  const ops: Promise<unknown>[] = [];
  for (const p of pages) {
    ops.push(tx.objectStore('results').delete(p.id));
    ops.push(tx.objectStore('corrections').delete(p.id));
    if (p.rasterKey) ops.push(tx.objectStore('blobs').delete(p.rasterKey));
    ops.push(tx.objectStore('pages').delete(p.id));
  }
  if (doc) ops.push(tx.objectStore('blobs').delete(doc.blobKey));
  ops.push(tx.objectStore('documents').delete(docId));
  ops.push(tx.done);
  await Promise.all(ops);
}

/** Approximate persisted storage usage, for the debug/technical readout. */
export async function storageEstimate(): Promise<{ usage?: number; quota?: number }> {
  const s = navigator.storage;
  if (s && typeof s.estimate === 'function') {
    try {
      const { usage, quota } = await s.estimate();
      return { usage, quota };
    } catch {
      /* ignore */
    }
  }
  return {};
}
