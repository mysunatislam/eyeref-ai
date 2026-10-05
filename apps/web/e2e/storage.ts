import type { Page } from "@playwright/test";

/** Runs `fn` against the app's IndexedDB store, creating it the way the app does if needed. */
async function withStore<T>(page: Page, mode: IDBTransactionMode, rows: unknown[] | null): Promise<T> {
  return page.evaluate(
    ({ mode, rows }) =>
      new Promise<T>((resolve, reject) => {
        const open = indexedDB.open("eyeref", 1);
        open.onupgradeneeded = () =>
          open.result
            .createObjectStore("assessments", { keyPath: "id" })
            .createIndex("createdAt", "createdAt");
        open.onsuccess = () => {
          const t = open.result.transaction("assessments", mode);
          const s = t.objectStore("assessments");
          let out: unknown;
          if (rows) for (const r of rows) s.put(r);
          else s.getAll().onsuccess = (e) => (out = (e.target as IDBRequest).result);
          t.oncomplete = () => resolve(out as T);
          t.onerror = () => reject(t.error);
        };
        open.onerror = () => reject(open.error);
      }),
    { mode, rows },
  );
}

/** Writes records straight into storage, as another version of the app would have left them. */
export async function seed(page: Page, records: Record<string, unknown>[]) {
  if (page.url() === "about:blank") await page.goto("/history");
  await withStore(page, "readwrite", records);
}

/** Every record in storage, as stored. */
export const stored = (page: Page) => withStore<Record<string, unknown>[]>(page, "readonly", null);

const EYES = { OD: { outputLevel: "screening" }, OS: { outputLevel: "screening" } };

/** A minimal stored assessment; `report` defaults to one this version can read. */
export const record = (
  id: string,
  {
    report = { simulated: false, eyes: EYES },
    createdAt = "2026-10-05T09:00:00.000Z",
    frames = [],
  }: { report?: unknown; createdAt?: string; frames?: unknown[] } = {},
) => ({
  id,
  createdAt,
  profile: { label: `P-${id}`, ageGroup: "unknown" },
  report,
  frames,
  visionTests: [],
});
