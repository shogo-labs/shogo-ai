/**
 * IndexedDB-backed persistence for FileSystemDirectoryHandle.
 * Handles are structured-cloneable and can be safely stored in idb;
 * we still need the user to grant permission again on reload.
 */

const DB_NAME = "shogo-ide";
const DB_VERSION = 1;
const STORE = "localRoots";

interface Record {
  id: string;
  label: string;
  handle: FileSystemDirectoryHandle;
  openedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export async function saveRoot(id: string, label: string, handle: FileSystemDirectoryHandle) {
  const rec: Record = { id, label, handle, openedAt: Date.now() };
  await tx("readwrite", (s) => s.put(rec));
}

export async function listRoots(): Promise<Record[]> {
  return tx<Record[]>("readonly", (s) => s.getAll() as IDBRequest<Record[]>);
}

export async function deleteRoot(id: string) {
  await tx("readwrite", (s) => s.delete(id));
}

export async function touchRoot(id: string) {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      const r = req.result as Record | undefined;
      if (r) {
        r.openedAt = Date.now();
        store.put(r);
      }
    };
    req.onerror = () => reject(req.error);
    t.oncomplete = () => {
      db.close();
      resolve();
    };
  });
}
