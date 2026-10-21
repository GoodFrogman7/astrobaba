import { shortfallPaise } from "@/lib/billing/amount";
import { call } from "@/lib/billing/client";
import { BILLING } from "@/lib/billing/config";
import type { IntentKeys } from "@/lib/billing/idempotency";
import { AI_QUESTION } from "./config";
import type { AiQuestion } from "./types";

export type QuestionError = "empty" | "tooLong";

/** 1–max_chars characters after trimming (docs/api/revenue.md §3). */
export function validateQuestion(text: string, max = AI_QUESTION.maxChars): QuestionError | null {
  const n = Array.from(text.trim()).length;
  if (n === 0) return "empty";
  if (n > max) return "tooLong";
  return null;
}

export function questionPending(q: Pick<AiQuestion, "status">): boolean {
  return q.status === "queued";
}

export const BLOCKED_KEYS = ["selfHarm", "medical", "legal", "financial", "unsafe"] as const;
export type BlockedKey = (typeof BLOCKED_KEYS)[number];

/**
 * Plain words for `blocked_reason`. The contract gives a string, not a fixed list, so known
 * topics are matched loosely and anything else gets the general explanation.
 */
export function blockedKey(reason: string | null): BlockedKey {
  const r = (reason ?? "").toLowerCase();
  if (/self[\s_-]?harm|suicid/.test(r)) return "selfHarm";
  if (/medic|health/.test(r)) return "medical";
  if (/legal|law/.test(r)) return "legal";
  if (/financ|invest|money/.test(r)) return "financial";
  return "unsafe";
}

export type AskOutcome =
  | { kind: "queued"; question: AiQuestion }
  | { kind: "invalid"; error: QuestionError }
  | { kind: "signin" }
  | { kind: "insufficient"; required: number; available: number; suggest: number }
  | { kind: "message"; key: "unavailable" | "network" | "consentRequired" | "generic" };

/**
 * POST /api/ai/conversations/{id}/questions with an Idempotency-Key per question text, so a
 * retry after a network error never charges twice.
 */
export async function askQuestion(
  conversationId: string,
  text: string,
  ctx: { keys: IntentKeys; balance: number | null; price?: number },
  post: typeof call = call,
): Promise<AskOutcome> {
  const error = validateQuestion(text);
  if (error) return { kind: "invalid", error };
  const clean = text.trim();
  const r = await post<AiQuestion>(`/api/ai/conversations/${conversationId}/questions`, {
    method: "POST",
    body: { text: clean },
    idempotencyKey: ctx.keys.for(`${conversationId}|${clean}`),
  });
  if (r.ok) {
    ctx.keys.done();
    return { kind: "queued", question: r.data };
  }
  if (r.status === 0) return { kind: "message", key: "network" };
  ctx.keys.done();
  if (r.status === 401) return { kind: "signin" };
  if (r.status === 402 || r.error.code === "insufficient_funds") {
    const required =
      typeof r.error.required_paise === "number"
        ? r.error.required_paise
        : (ctx.price ?? AI_QUESTION.pricePaise);
    const available =
      typeof r.error.available_paise === "number"
        ? r.error.available_paise
        : Math.max(0, ctx.balance ?? 0);
    const suggest = shortfallPaise(required, available, {
      min_paise: BILLING.recharge.minPaise,
      max_paise: BILLING.recharge.maxPaise,
    });
    return { kind: "insufficient", required, available, suggest };
  }
  if (r.status === 404) return { kind: "message", key: "unavailable" };
  if (r.status === 403 && r.error.code === "consent_required")
    return { kind: "message", key: "consentRequired" };
  return { kind: "message", key: "generic" };
}
