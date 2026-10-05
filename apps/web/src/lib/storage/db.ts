/**
 * On-device storage (IndexedDB). Assessments never leave the device unless the user
 * explicitly uploads them to a research server in Dataset Collection Mode.
 */
import type { StoredAssessment } from "../types";
import { isValidAssessment, plainExport, withoutImages } from "./backup";
import { imagesIn, isExpired, withoutCrops } from "./retention";

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

const listeners = new Set<() => void>();

/** Calls `listener` whenever this tab changes the stored assessments. Returns the unsubscribe. */
export function onAssessmentsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function write<T>(fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const result = await tx("readwrite", fn);
  listeners.forEach((l) => l());
  return result;
}

export const saveAssessment = (a: StoredAssessment) => write((s) => s.put(a));
export const getAssessment = (id: string) => tx<StoredAssessment | undefined>("readonly", (s) => s.get(id));
export const deleteAssessment = (id: string) => write((s) => s.delete(id));
export const clearAssessments = () => write((s) => s.clear());

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
    t.oncomplete = () => {
      resolve();
      listeners.forEach((l) => l());
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

/**
 * Removes the eye images of every stored record `select` picks, keeping results, in one
 * transaction. Records this version cannot read are included, so a privacy limit covers all
 * that is stored. Resolves to the number of images removed.
 */
async function removeImages(select: (record: unknown) => boolean): Promise<number> {
  const db = await open();
  const removed = await new Promise<number>((resolve, reject) => {
    let n = 0;
    const t = db.transaction(STORE, "readwrite");
    const cursor = t.objectStore(STORE).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const stripped = select(c.value) ? withoutCrops(c.value) : null;
      if (stripped) {
        n += imagesIn(c.value);
        c.update(stripped);
      }
      c.continue();
    };
    t.oncomplete = () => resolve(n);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  if (removed) listeners.forEach((l) => l());
  return removed;
}

/** Deletes every stored eye image. Results stay. */
export const removeAllImages = () => removeImages(() => true);

/** Deletes eye images from assessments made more than `days` days ago. Results stay. */
export const removeExpiredImages = (days: number, now = Date.now()) =>
  removeImages((r) => isExpired(r, days, now));

export const listIds = () => tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());

/** Plain JSON for analysis. Eye images are left out; an encrypted backup keeps them. */
export function exportJson(items: StoredAssessment[]): Blob {
  return new Blob([JSON.stringify(plainExport(withoutImages(items)), null, 1)], {
    type: "application/json",
  });
}
