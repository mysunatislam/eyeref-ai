"use client";
import { useCallback, useEffect, useState } from "react";
import type { StoredAssessment } from "../types";
import { getAssessment, listAssessments } from "./db";

export function useAssessment(id: string | null) {
  const [data, setData] = useState<StoredAssessment | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    if (!id) {
      Promise.resolve().then(() => alive && setData(null));
      return;
    }
    getAssessment(id)
      .then((a) => alive && setData(a ?? null))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [id]);
  return data;
}

export function useAssessments() {
  const [items, setItems] = useState<StoredAssessment[] | null>(null);
  const reload = useCallback(() => {
    listAssessments()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);
  useEffect(reload, [reload]);
  return { items, reload };
}
