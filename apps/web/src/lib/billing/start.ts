import type { SessionKind } from "@astro/shared";
import { shortfallPaise } from "./amount";
import { call } from "./client";
import { BILLING, minStartPaise } from "./config";
import type { IntentKeys } from "./idempotency";
import type { ApiErrorBody } from "./types";

export type Outcome =
  | { kind: "signin" }
  | { kind: "insufficient"; minutes: number; required: number; suggest: number }
  | { kind: "open"; sessionId: string | null }
  | {
      kind: "message";
      key:
        | "chatUnavailable"
        | "callUnavailable"
        | "ownProfile"
        | "freeUnavailable"
        | "consentRequired"
        | "generic";
    };

/** What to tell the user for a failed POST /api/sessions (docs/api/billing.md create checks). */
export function outcomeFor(
  status: number,
  e: ApiErrorBody,
  ctx: { pricePerMinPaise: number; balancePaise: number | null },
): Outcome {
  if (status === 401) return { kind: "signin" };
  if (status === 402 || e.code === "insufficient_funds") {
    const required =
      typeof e.required_paise === "number" ? e.required_paise : minStartPaise(ctx.pricePerMinPaise);
    const minutes =
      typeof e.minutes_affordable === "number"
        ? e.minutes_affordable
        : ctx.balancePaise !== null
          ? Math.floor(ctx.balancePaise / ctx.pricePerMinPaise)
          : 0;
    const suggest = shortfallPaise(required, ctx.balancePaise ?? 0, {
      min_paise: BILLING.recharge.minPaise,
      max_paise: BILLING.recharge.maxPaise,
    });
    return { kind: "insufficient", minutes, required, suggest };
  }
  if (e.code === "session_open")
    return { kind: "open", sessionId: typeof e.session_id === "string" ? e.session_id : null };
  if (e.code === "own_profile") return { kind: "message", key: "ownProfile" };
  // The consent step was closed without accepting (docs/api/trust.md §1).
  if (status === 403 && e.code === "consent_required")
    return { kind: "message", key: "consentRequired" };
  if (e.code === "free_session_unavailable") return { kind: "message", key: "freeUnavailable" };
  // Calls: the voice_calls flag is off or the astrologer does not take calls (portal.md §1).
  if (e.code === "call_unavailable") return { kind: "message", key: "callUnavailable" };
  if (e.code === "chat_unavailable" || status === 404)
    return { kind: "message", key: "chatUnavailable" };
  return { kind: "message", key: "generic" };
}

/**
 * POST /api/sessions for a chat or a call. One Idempotency-Key per intent (astrologer, kind,
 * free/paid): a network error keeps it, so pressing again retries the same request instead of
 * opening a second session; any answer from the API retires it.
 */
export async function requestSession(
  o: {
    astrologerId: string;
    kind: SessionKind;
    free: boolean;
    pricePerMinPaise: number;
    balancePaise: number | null;
    keys: IntentKeys;
  },
  post: typeof call = call,
): Promise<{ ok: true; id: string } | { ok: false; outcome: Outcome }> {
  const intent = `${o.astrologerId}:${o.kind}:${o.free ? "free" : "paid"}`;
  const r = await post<{ id: string }>("/api/sessions", {
    method: "POST",
    body: { astrologer_id: o.astrologerId, kind: o.kind, free: o.free },
    idempotencyKey: o.keys.for(intent),
  });
  if (r.ok) {
    o.keys.done();
    return { ok: true, id: r.data.id };
  }
  if (r.status !== 0) o.keys.done();
  return {
    ok: false,
    outcome: outcomeFor(r.status, r.error, {
      pricePerMinPaise: o.pricePerMinPaise,
      balancePaise: o.balancePaise,
    }),
  };
}
