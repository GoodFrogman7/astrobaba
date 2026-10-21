"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApplicantMe } from "@/lib/marketplace/types";

export type ApplicantState =
  | { kind: "loading" }
  | { kind: "signed_out" }
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "ready"; me: ApplicantMe };

/** Loads the signed-in user's application via the web route handler. */
export function useApplicant() {
  const [state, setState] = useState<ApplicantState>({ kind: "loading" });
  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/astrologer/me", { cache: "no-store" });
      if (!res.ok) return setState({ kind: "error" });
      const body = (await res.json()) as { signed_in: boolean; application: ApplicantMe | null };
      if (!body.signed_in) setState({ kind: "signed_out" });
      else if (!body.application) setState({ kind: "none" });
      else setState({ kind: "ready", me: body.application });
    } catch {
      setState({ kind: "error" });
    }
  }, []);
  useEffect(() => {
    // Initial load after mount (client-only data: the session is an httpOnly cookie).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);
  return { state, reload };
}
