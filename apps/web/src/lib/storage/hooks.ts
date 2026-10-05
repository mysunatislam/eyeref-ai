"use client";
import { useCallback, useEffect, useState } from "react";
import type { StoredAssessment } from "../types";
import { isValidAssessment } from "./backup";
import { getAssessment, listAssessments } from "./db";

export type LoadedAssessment =
  | { status: "loading" }
  | { status: "missing" }
  /** Stored here, but written by another version or damaged. */
  | { status: "unreadable" }
  | { status: "ok"; assessment: StoredAssessment };

export function useAssessment(id: string | null): LoadedAssessment {
  const [state, setState] = useState<LoadedAssessment>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    const set = (s: LoadedAssessment) => alive && setState(s);
    if (!id) {
      Promise.resolve().then(() => set({ status: "missing" }));
      return;
    }
    getAssessment(id)
      .then((a) =>
        set(
          a === undefined
            ? { status: "missing" }
            : isValidAssessment(a)
              ? { status: "ok", assessment: a }
              : { status: "unreadable" },
        ),
      )
      .catch(() => set({ status: "unreadable" }));
    return () => {
      alive = false;
    };
  }, [id]);
  return state;
}

export function useAssessments() {
  const [state, setState] = useState<{ items: StoredAssessment[]; unreadable: number } | null>(null);
  const reload = useCallback(() => {
    listAssessments()
      .then(setState)
      .catch(() => setState({ items: [], unreadable: 0 }));
  }, []);
  useEffect(reload, [reload]);
  return { items: state?.items ?? null, unreadable: state?.unreadable ?? 0, reload };
}
