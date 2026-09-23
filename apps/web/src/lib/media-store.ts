/**
 * IndexedDB persistence for autosave drafts + their media Files (browser only).
 *
 * Everything here FAILS SOFT: IndexedDB can be missing (SSR, old browsers),
 * throw on open (Firefox private mode: InvalidStateError), be blocked by site
 * settings, or reject writes (QuotaExceededError for big videos). Every function
 * resolves to a neutral value (null / false / []) instead of throwing, so the
 * editor keeps working with autosave simply off.
 *
 * Schema (db "cadence-autosave" v1):
 *   drafts: keyPath "key"  → DraftRecord (doc + media registry + transcripts)
 *   media:  keyPath "id", index "draftKey" → StoredMedia (the File bytes, once)
 * Blobs/Files are structured-cloneable, so IndexedDB stores them natively.
 */
import type { DraftRecord, StoredMedia } from "./autosave";

const DB_NAME = "cadence-autosave";
const DB_VERSION = 1;
const DRAFTS = "drafts";
const MEDIA = "media";

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Open (once) the autosave database, or null when IndexedDB is unusable. */
export function openAutosaveDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DRAFTS)) db.createObjectStore(DRAFTS, { keyPath: "key" });
        if (!db.objectStoreNames.contains(MEDIA)) {
          const media = db.createObjectStore(MEDIA, { keyPath: "id" });
          media.createIndex("draftKey", "draftKey", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgrading the schema → close so it isn't blocked.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

/** Run one transaction; resolves with `fn`'s value once it COMMITS (or null on any failure). */
async function withStore<T>(
  names: string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T | null> {
  const db = await openAutosaveDb();
  if (!db) return null;
  return new Promise<T | null>((resolve) => {
    let result: T | null = null;
    let tx: IDBTransaction;
    try {
      tx = db.transaction(names, mode);
    } catch {
      resolve(null);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
    Promise.resolve()
      .then(() => fn(tx))
      .then((v) => {
        result = v;
      })
      .catch(() => {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
      });
  });
}

/** Promise wrapper for a single IDBRequest. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function getDraftRecord(key: string): Promise<unknown | null> {
  return withStore([DRAFTS], "readonly", (tx) => req(tx.objectStore(DRAFTS).get(key)));
}

/** Write the draft; true on commit. */
export async function putDraftRecord(record: DraftRecord): Promise<boolean> {
  const ok = await withStore([DRAFTS], "readwrite", async (tx) => {
    await req(tx.objectStore(DRAFTS).put(record));
    return true;
  });
  return ok === true;
}

/** Ids of the media Files stored for a draft. */
export async function listStoredMediaIds(draftKey: string): Promise<string[]> {
  const ids = await withStore([MEDIA], "readonly", (tx) =>
    req(tx.objectStore(MEDIA).index("draftKey").getAllKeys(IDBKeyRange.only(draftKey))),
  );
  return (ids ?? []).map(String);
}

/** Every stored media File for a draft. */
export async function getStoredMedia(draftKey: string): Promise<StoredMedia[]> {
  const rows = await withStore([MEDIA], "readonly", (tx) =>
    req(tx.objectStore(MEDIA).index("draftKey").getAll(IDBKeyRange.only(draftKey))),
  );
  return ((rows ?? []) as StoredMedia[]).filter((r) => r && r.blob instanceof Blob);
}

/** Store one media File; false on failure (e.g. QuotaExceededError). */
export async function putStoredMedia(draftKey: string, id: string, file: File): Promise<boolean> {
  const row: StoredMedia = {
    id,
    draftKey,
    blob: file,
    name: file.name,
    type: file.type,
    lastModified: file.lastModified,
    size: file.size,
  };
  const ok = await withStore([MEDIA], "readwrite", async (tx) => {
    await req(tx.objectStore(MEDIA).put(row));
    return true;
  });
  return ok === true;
}

export async function deleteStoredMedia(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await withStore([MEDIA], "readwrite", async (tx) => {
    const store = tx.objectStore(MEDIA);
    await Promise.all(ids.map((id) => req(store.delete(id))));
    return true;
  });
}

/** Remove a draft AND all its media. */
export async function deleteDraft(draftKey: string): Promise<void> {
  const ids = await listStoredMediaIds(draftKey);
  await withStore([DRAFTS, MEDIA], "readwrite", async (tx) => {
    await req(tx.objectStore(DRAFTS).delete(draftKey));
    const store = tx.objectStore(MEDIA);
    await Promise.all(ids.map((id) => req(store.delete(id))));
    return true;
  });
}

/** Rebuild a File from a stored row (name/type/lastModified preserved). */
export function storedToFile(row: StoredMedia): File {
  return new File([row.blob], row.name || row.id, { type: row.type || row.blob.type, lastModified: row.lastModified || Date.now() });
}
