import { REPORT_SKUS, type ReportLanguage, type ReportSku } from "@astro/shared";
import { shortfallPaise } from "@/lib/billing/amount";
import { call } from "@/lib/billing/client";
import { BILLING } from "@/lib/billing/config";
import type { IntentKeys } from "@/lib/billing/idempotency";
import type { ApiErrorBody } from "@/lib/billing/types";
import { KUNDLIS_PER_SKU } from "./config";
import type { ReportOrder } from "./types";

export type PayWith = "wallet" | "razorpay";

export interface OrderInput {
  sku: ReportSku;
  language: ReportLanguage;
  kundliIds: string[];
  payWith: PayWith;
  email: string;
}

export type OrderError =
  "sku" | "language" | "kundliCount" | "kundliDistinct" | "email" | "payWith";

/** Loose shape check only; the API validates the address it stores (and erases after use). */
export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * Checks before any request: a known report, a language it is offered in, exactly as many
 * different saved kundlis as the report needs (1 for kundli, 2 for matching), an optional email.
 */
export function validateOrder(
  o: OrderInput,
  languages: ReportLanguage[] = ["en", "hi"],
): OrderError[] {
  const errors: OrderError[] = [];
  if (!REPORT_SKUS.includes(o.sku)) return ["sku"];
  if (!languages.includes(o.language)) errors.push("language");
  const ids = o.kundliIds.filter(Boolean);
  if (ids.length !== KUNDLIS_PER_SKU[o.sku]) errors.push("kundliCount");
  else if (new Set(ids).size !== ids.length) errors.push("kundliDistinct");
  if (o.email.trim() && !EMAIL.test(o.email.trim())) errors.push("email");
  if (o.payWith !== "wallet" && o.payWith !== "razorpay") errors.push("payWith");
  return errors;
}

/** The request body for POST /v1/reports/orders (docs/api/revenue.md §2.1). */
export function orderBody(o: OrderInput) {
  const email = o.email.trim();
  return {
    sku: o.sku,
    language: o.language,
    kundli_ids: o.kundliIds,
    pay_with: o.payWith,
    ...(email ? { email } : {}),
  };
}

/** Same choices → same intent → same Idempotency-Key (a retry never buys twice). */
export function intentOf(o: OrderInput): string {
  return [o.sku, o.language, o.kundliIds.join("+"), o.payWith, o.email.trim()].join("|");
}

export type BuyOutcome =
  | { kind: "paid"; order: ReportOrder }
  | { kind: "checkout"; order: ReportOrder }
  | { kind: "failed"; order: ReportOrder }
  | { kind: "signin" }
  | { kind: "insufficient"; required: number; available: number; suggest: number }
  | { kind: "invalid"; errors: OrderError[] }
  | { kind: "message"; key: "kundliNotFound" | "conflict" | "network" | "generic" };

/** What a failed POST means for the user. */
export function orderErrorOutcome(
  status: number,
  e: ApiErrorBody,
  price: number,
  balance: number | null,
): BuyOutcome {
  if (status === 401) return { kind: "signin" };
  if (status === 402 || e.code === "insufficient_funds") {
    const required = typeof e.required_paise === "number" ? e.required_paise : price;
    const available =
      typeof e.available_paise === "number" ? e.available_paise : Math.max(0, balance ?? 0);
    const suggest = shortfallPaise(required, available, {
      min_paise: BILLING.recharge.minPaise,
      max_paise: BILLING.recharge.maxPaise,
    });
    return { kind: "insufficient", required, available, suggest };
  }
  if (status === 0) return { kind: "message", key: "network" };
  if (status === 409 && e.code === "idempotency_conflict")
    return { kind: "message", key: "conflict" };
  if (status === 404 || e.code === "kundli_not_found")
    return { kind: "message", key: "kundliNotFound" };
  return { kind: "message", key: "generic" };
}

/**
 * POST /api/reports/orders with one Idempotency-Key per intent. A network error keeps the key
 * (pressing again retries the same order); any answer from the API retires it.
 */
export async function placeOrder(
  o: OrderInput,
  ctx: { price: number; balance: number | null; keys: IntentKeys; languages?: ReportLanguage[] },
  post: typeof call = call,
): Promise<BuyOutcome> {
  const errors = validateOrder(o, ctx.languages);
  if (errors.length) return { kind: "invalid", errors };
  const r = await post<ReportOrder>("/api/reports/orders", {
    method: "POST",
    body: orderBody(o),
    idempotencyKey: ctx.keys.for(intentOf(o)),
  });
  if (!r.ok) {
    if (r.status !== 0) ctx.keys.done();
    return orderErrorOutcome(r.status, r.error, ctx.price, ctx.balance);
  }
  const order = r.data;
  if (order.status === "paid") {
    ctx.keys.done();
    return { kind: "paid", order };
  }
  if (order.status === "failed") {
    ctx.keys.done();
    return { kind: "failed", order };
  }
  // Razorpay: the order exists; payment happens in Checkout (or the dev simulator). The key is
  // kept until it settles, so a double click never opens a second order.
  return { kind: "checkout", order };
}

/** What the buy dialog shows. */
export type BuyState =
  | { step: "idle" }
  | { step: "creating" }
  | { step: "invalid"; errors: OrderError[] }
  | { step: "insufficient"; required: number; available: number; suggest: number }
  | { step: "message"; key: "kundliNotFound" | "conflict" | "network" | "generic" | "script" }
  | { step: "signin" }
  | { step: "checkout"; order: ReportOrder }
  | { step: "dev"; order: ReportOrder }
  | { step: "verifying"; order: ReportOrder }
  | { step: "pending"; order: ReportOrder; slow: boolean }
  | { step: "paid"; order: ReportOrder }
  | { step: "failed" }
  | { step: "dismissed" };

export const BUSY: BuyState["step"][] = ["creating", "checkout", "dev", "verifying", "pending"];

/** Map a placeOrder outcome to the next screen state (razorpay orders go on to checkout). */
export function stateFor(o: BuyOutcome): BuyState {
  switch (o.kind) {
    case "paid":
      return { step: "paid", order: o.order };
    case "failed":
      return { step: "failed" };
    case "checkout":
      return { step: "checkout", order: o.order };
    case "signin":
      return { step: "signin" };
    case "insufficient":
      return { step: "insufficient", ...o };
    case "invalid":
      return { step: "invalid", errors: o.errors };
    case "message":
      return { step: "message", key: o.key };
  }
}
