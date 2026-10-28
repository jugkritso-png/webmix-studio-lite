// Copies of video, audio and large image files in the browser (IndexedDB), so a show reopens
// with its clips without picking the files again — as WebMix Pro does. Keyed by source id.

export interface StoredFile {
  name: string;
  type: string;
  blob: Blob;
}

const DB = 'webmix-lite-files';
const STORE = 'files';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // ask the browser not to evict these copies when space runs low
    void navigator.storage?.persist?.().catch(() => false);
  }
  return dbp;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const req = fn(d.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function putFiles(id: string, files: File[] | StoredFile[]): Promise<boolean> {
  try {
    const list: StoredFile[] = files.map((f) => ('blob' in f ? f : { name: f.name, type: f.type, blob: f }));
    await run('readwrite', (s) => s.put(list, id));
    return true;
  } catch {
    return false; // out of space or private mode: the file just has to be picked again next time
  }
}

export async function getFiles(id: string): Promise<StoredFile[] | null> {
  try {
    return (await run<StoredFile[] | undefined>('readonly', (s) => s.get(id))) ?? null;
  } catch {
    return null;
  }
}

/** drop copies whose source is no longer in the show */
export async function pruneFiles(keep: Set<string>): Promise<void> {
  try {
    const keys = await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    await Promise.all(keys.filter((k) => !keep.has(String(k))).map((k) => run('readwrite', (s) => s.delete(k))));
  } catch { /* nothing to clean */ }
}
