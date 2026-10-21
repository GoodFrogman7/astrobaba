import "server-only";

import type { ConsentState } from "@astro/shared";
import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { StatusNotice } from "@/components/StatusNotice";
import { TermsGatePage } from "@/components/TermsGatePage";
import { withLiveAstrologer } from "./access";
import { api, fetchMe } from "./api";
import { termsGate } from "./trust";
import type { Me } from "./types";

/**
 * Page guard: anonymous → /login; signed-in but not live → status notice and no data; live but
 * without the current astrologer terms (trust.md §1) → the terms gate and no data.
 *
 * `terms: false` skips the gate. Only the session room uses it, so a consultation in progress
 * is never cut off by a new terms version (chat messages do not need the consent).
 */
export async function consolePage<T>(
  load: (me: Me) => Promise<T>,
  { terms = true }: { terms?: boolean } = {},
): Promise<{ live: true; data: T } | { live: false; notice: ReactElement }> {
  type Loaded = { gated: true; version: string } | { gated: false; data: T };
  const { access, data } = await withLiveAstrologer(fetchMe, async (me): Promise<Loaded> => {
    if (terms) {
      const gate = await termsGate(() => api.get<ConsentState>("/v1/me/consents"));
      if (gate.gate) return { gated: true, version: gate.version };
    }
    return { gated: false, data: await load(me) };
  });
  if (access.kind === "anon") redirect("/login");
  if (access.kind !== "live") return { live: false, notice: <StatusNotice access={access} /> };
  // `data` is always set for a live astrologer (withLiveAstrologer ran the loader).
  const result = data!;
  if (result.gated) return { live: false, notice: <TermsGatePage version={result.version} /> };
  return { live: true, data: result.data };
}
