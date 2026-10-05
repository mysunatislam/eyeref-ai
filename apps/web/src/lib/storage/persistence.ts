"use client";
import { useCallback, useEffect, useState } from "react";

/**
 * Whether the browser has promised to keep this app's data. Without that promise, browsers may
 * clear website data to free up space, or after a site goes unused for a while. `null` means the
 * browser cannot make the promise (or the page is not served over HTTPS).
 */
export type Persistence = boolean | null;

const storage = () => (typeof navigator === "undefined" ? undefined : navigator.storage);

async function persisted(): Promise<Persistence> {
  try {
    return (await storage()?.persisted?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * The browser's promise to keep this app's data (undefined while checking), and a way to ask for
 * it. Asking is left to a button: Firefox shows a prompt, which should follow a deliberate tap.
 */
export function usePersistence(): [Persistence | undefined, () => Promise<boolean>] {
  const [state, setState] = useState<Persistence | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void persisted().then((p) => alive && setState(p));
    return () => {
      alive = false;
    };
  }, []);
  const ask = useCallback(async () => {
    let granted = false;
    try {
      granted = (await storage()?.persist?.()) ?? false;
    } catch {
      /* treated as declined */
    }
    setState(await persisted());
    return granted;
  }, []);
  return [state, ask];
}
