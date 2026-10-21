import { shortfallPaise } from "./amount";
import { BILLING, minStartPaise } from "./config";
import type { ApiErrorBody } from "./types";

export type Outcome =
  | { kind: "signin" }
  | { kind: "insufficient"; minutes: number; required: number; suggest: number }
  | { kind: "open"; sessionId: string | null }
  | { kind: "message"; key: "chatUnavailable" | "ownProfile" | "freeUnavailable" | "generic" };

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
  if (e.code === "free_session_unavailable") return { kind: "message", key: "freeUnavailable" };
  if (e.code === "chat_unavailable" || status === 404)
    return { kind: "message", key: "chatUnavailable" };
  return { kind: "message", key: "generic" };
}
