/**
 * On-device storage (IndexedDB). Assessments never leave the device unless the user
 * explicitly uploads them to a research server in Dataset Collection Mode.
 */
import type { StoredAssessment } from "../types";

const DB_NAME = "eyeref";
const STORE = "assessments";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: "id" });
        s.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export const saveAssessment = (a: StoredAssessment) => tx("readwrite", (s) => s.put(a));
export const getAssessment = (id: string) => tx<StoredAssessment | undefined>("readonly", (s) => s.get(id));
export const deleteAssessment = (id: string) => tx("readwrite", (s) => s.delete(id));
export const clearAssessments = () => tx("readwrite", (s) => s.clear());

export async function listAssessments(): Promise<StoredAssessment[]> {
  const all = await tx<StoredAssessment[]>("readonly", (s) => s.getAll());
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function exportJson(items: StoredAssessment[]): Blob {
  return new Blob(
    [
      JSON.stringify(
        { format: "eyeref-assessments/1", exportedAt: new Date().toISOString(), items },
        null,
        1,
      ),
    ],
    {
      type: "application/json",
    },
  );
}
