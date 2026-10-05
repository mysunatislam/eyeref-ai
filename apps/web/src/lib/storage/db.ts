/**
 * On-device storage (IndexedDB). Assessments never leave the device unless the user
 * explicitly uploads them to a research server in Dataset Collection Mode.
 */
import type { StoredAssessment } from "../types";
import { isValidAssessment, plainExport, withoutImages } from "./backup";

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

/**
 * Every readable assessment, newest first, with a count of the records that could not be read
 * (written by an older version, or damaged). One bad record must not hide the rest.
 */
export async function listAssessments(): Promise<{ items: StoredAssessment[]; unreadable: number }> {
  const all = await tx<unknown[]>("readonly", (s) => s.getAll());
  const items = all.filter(isValidAssessment).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items, unreadable: all.length - items.length };
}

/** Saves several assessments in one transaction. Never overwrites: a duplicate id aborts it all. */
export async function addAssessments(items: StoredAssessment[]): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const s = t.objectStore(STORE);
    for (const a of items) s.add(a);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const listIds = () => tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());

/** Plain JSON for analysis. Eye images are left out; an encrypted backup keeps them. */
export function exportJson(items: StoredAssessment[]): Blob {
  return new Blob([JSON.stringify(plainExport(withoutImages(items)), null, 1)], {
    type: "application/json",
  });
}
