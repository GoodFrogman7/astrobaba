import type { AstrologerStatus, Me } from "./types";

/** Statuses in which an astrologer is live on the marketplace (marketplace.md, visibility rule). */
export const LIVE_STATUSES: readonly AstrologerStatus[] = ["probation", "approved"];

export type Access =
  | { kind: "anon" }
  | { kind: "not_astrologer"; me: Me }
  | { kind: "not_live"; me: Me; status: AstrologerStatus }
  | { kind: "live"; me: Me; astrologerId: string };

export function decideAccess(me: Me | null): Access {
  if (!me) return { kind: "anon" };
  const a = me.astrologer;
  if (!a) return { kind: "not_astrologer", me };
  if (!LIVE_STATUSES.includes(a.status)) return { kind: "not_live", me, status: a.status };
  return { kind: "live", me, astrologerId: a.id };
}

/** Plain-language status for astrologers who are not live yet (or any more). */
export const STATUS_TEXT: Record<AstrologerStatus, string> = {
  applied: "Your application is in. Upload your identity and qualification documents next.",
  kyc_submitted: "Your documents are with our team for review.",
  interview: "Your documents are checked. The next step is a short interview.",
  probation: "You are live on probation.",
  approved: "You are live.",
  suspended: "Your profile is suspended, so you cannot take consultations right now.",
  rejected: "Your application was not accepted.",
};

/**
 * Load page data only for live astrologers: `load` is never called otherwise, so nothing is
 * requested from the API on behalf of a session that may not use the console.
 */
export async function withLiveAstrologer<T>(
  fetchMe: () => Promise<Me | null>,
  load: (me: Me) => Promise<T>,
): Promise<{ access: Access; data: T | null }> {
  const access = decideAccess(await fetchMe());
  if (access.kind !== "live") return { access, data: null };
  return { access, data: await load(access.me) };
}
