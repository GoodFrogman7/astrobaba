"use client";

import { useEffect, useState } from "react";
import { call } from "@/lib/billing/client";
import type { SavedKundli } from "@/lib/revenue/types";

/**
 * The signed-in user's saved kundlis (GET /api/kundlis): undefined while loading, null on
 * error. Loads only when `enabled` (after we know the visitor is signed in).
 */
export function useKundlis(enabled: boolean): SavedKundli[] | null | undefined {
  const [list, setList] = useState<SavedKundli[] | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void call<SavedKundli[] | { items: SavedKundli[] }>("/api/kundlis").then((r) => {
      if (!live) return;
      if (!r.ok) return setList(null);
      setList(Array.isArray(r.data) ? r.data : (r.data.items ?? []));
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return list;
}
