"use client";

import { BRAND_NAME } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { inBounds, paiseToInput, parseRupees } from "@/lib/billing/amount";
import { call, refreshWallet } from "@/lib/billing/client";
import { BILLING } from "@/lib/billing/config";
import { IntentKeys } from "@/lib/billing/idempotency";
import { pollOrder } from "@/lib/billing/poll";
import { loadRazorpay, type RazorpaySuccess } from "@/lib/billing/razorpay";
import type { RechargeOptions, RechargeOrder } from "@/lib/billing/types";
import { formatPaise } from "@/lib/marketplace/format";

type Pay =
  | { step: "idle" }
  | { step: "creating" }
  | { step: "checkout"; order: RechargeOrder }
  | { step: "dev"; order: RechargeOrder }
  | { step: "verifying"; order: RechargeOrder }
  | { step: "pending"; order: RechargeOrder; slow: boolean }
  | { step: "paid"; order: RechargeOrder }
  | { step: "failed" }
  | { step: "dismissed" }
  | { step: "error"; key: "amount_out_of_range" | "script" | "generic" };

/**
 * Recharge: packs or a custom amount, nothing pre-selected unless the user arrived with an
 * amount to add. The order is created by the API; Razorpay Checkout (or, in development, the
 * fake provider) takes the payment; the wallet is credited only by the webhook, so we poll the
 * order until it is paid or failed.
 */
export function RechargePanel({
  prefillPaise,
  onPaid,
}: {
  prefillPaise: number | null;
  onPaid: () => void;
}) {
  const t = useTranslations("billing.recharge");
  const locale = useLocale() as "en" | "hi";
  const fmt = (p: number) => formatPaise(p, locale);
  const [options, setOptions] = useState<RechargeOptions | null | "error">(null);
  const [pack, setPack] = useState<number | null>(null);
  const [custom, setCustom] = useState(prefillPaise ? paiseToInput(prefillPaise) : "");
  const [pay, setPay] = useState<Pay>({ step: "idle" });
  const keysRef = useRef<IntentKeys | null>(null);
  const alive = useRef(true);
  const inputId = useId();

  useEffect(() => {
    alive.current = true;
    void call<RechargeOptions>("/api/wallet/recharge-options").then((r) => {
      if (!alive.current) return;
      setOptions(r.ok ? r.data : "error");
      if (r.ok && r.data.provider === "razorpay") void loadRazorpay().catch(() => undefined);
    });
    return () => {
      alive.current = false;
    };
  }, []);

  if (options === null) return <p className="text-muted">…</p>;
  if (options === "error") return <p>{t("errors.generic")}</p>;
  const opts = options;

  const amount = pack ?? parseRupees(custom);
  const valid = amount !== null && inBounds(amount, opts);
  const busy = ["creating", "checkout", "verifying", "pending", "dev"].includes(pay.step);

  async function settle(order: RechargeOrder) {
    setPay({ step: "pending", order, slow: false });
    const r = await pollOrder(
      async () => {
        const res = await call<RechargeOrder>(`/api/wallet/recharge-orders/${order.id}`);
        return res.ok ? res.data : null;
      },
      { cancelled: () => !alive.current },
    );
    if (!alive.current) return;
    if (r.order?.status === "paid") {
      keysRef.current?.done();
      setPay({ step: "paid", order: r.order });
      void refreshWallet();
      onPaid();
    } else if (r.order?.status === "failed") {
      keysRef.current?.done();
      setPay({ step: "failed" });
    } else setPay({ step: "pending", order, slow: true });
  }

  async function checkout(order: RechargeOrder) {
    setPay({ step: "checkout", order });
    let Rzp;
    try {
      Rzp = await loadRazorpay();
    } catch {
      return setPay({ step: "error", key: "script" });
    }
    const rzp = new Rzp({
      key: order.key_id,
      order_id: order.provider_order_id,
      amount: order.amount_paise,
      currency: order.currency,
      name: BRAND_NAME,
      description: t("summary", { amount: fmt(order.amount_paise) }),
      handler: (res: RazorpaySuccess) => void verified(order, res),
      modal: {
        ondismiss: () => setPay((p) => (p.step === "checkout" ? { step: "dismissed" } : p)),
      },
    });
    rzp.open();
  }

  async function verified(order: RechargeOrder, res: RazorpaySuccess) {
    setPay({ step: "verifying", order });
    // Records the payment; the credit itself still comes from the webhook, so poll either way.
    await call<RechargeOrder>(`/api/wallet/recharge-orders/${order.id}/checkout-result`, {
      method: "POST",
      body: {
        provider_payment_id: res.razorpay_payment_id,
        provider_signature: res.razorpay_signature,
      },
    });
    await settle(order);
  }

  async function simulate(order: RechargeOrder, outcome: "captured" | "failed") {
    setPay({ step: "verifying", order });
    await call(`/api/dev/payments/${order.id}/simulate`, { method: "POST", body: { outcome } });
    await settle(order);
  }

  async function start() {
    if (amount === null || !valid) return;
    keysRef.current ??= new IntentKeys();
    const keys = keysRef.current;
    setPay({ step: "creating" });
    const r = await call<RechargeOrder>("/api/wallet/recharge-orders", {
      method: "POST",
      body: { amount_paise: amount },
      idempotencyKey: keys.for(`recharge:${amount}`),
    });
    if (!r.ok) {
      if (r.status !== 0) keys.done();
      return setPay({
        step: "error",
        key: r.error.code === "amount_out_of_range" ? "amount_out_of_range" : "generic",
      });
    }
    const order = r.data;
    if (order.status !== "created") return settle(order);
    if (order.provider === "fake") return setPay({ step: "dev", order });
    return checkout(order);
  }

  const bounds = t("bounds", { min: fmt(opts.min_paise), max: fmt(opts.max_paise) });
  const showOutOfRange = pack === null && custom.trim() !== "" && !valid;

  return (
    <section aria-labelledby="recharge" className="rounded-md border border-border bg-surface p-5">
      <h2 id="recharge" className="text-lg font-semibold">
        {t("heading")}
      </h2>
      <fieldset className="mt-3" disabled={busy}>
        <legend className="text-sm font-medium">{t("packs")}</legend>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {opts.packs.map((p) => (
            <button
              key={p.amount_paise}
              type="button"
              aria-pressed={pack === p.amount_paise}
              onClick={() => {
                setPack(p.amount_paise);
                setCustom("");
                setPay({ step: "idle" });
              }}
              className={`rounded-sm border px-3 py-2 text-left ${
                pack === p.amount_paise ? "border-primary bg-bg" : "border-border"
              }`}
            >
              <span className="block font-semibold tabular-nums">{fmt(p.amount_paise)}</span>
              {opts.bonus_enabled && p.bonus_paise > 0 && (
                <span className="block text-xs text-muted">
                  {t("bonus", { amount: fmt(p.bonus_paise) })}
                </span>
              )}
            </button>
          ))}
        </div>
        <label htmlFor={inputId} className="mt-4 block text-sm font-medium">
          {t("custom")}
        </label>
        <input
          id={inputId}
          inputMode="decimal"
          autoComplete="off"
          value={custom}
          onChange={(e) => {
            setCustom(e.target.value);
            setPack(null);
            setPay({ step: "idle" });
          }}
          aria-describedby={`${inputId}-hint`}
          aria-invalid={showOutOfRange || undefined}
          className="mt-1 w-full max-w-xs rounded-sm border border-border bg-surface px-3 py-2 tabular-nums"
        />
        <p id={`${inputId}-hint`} className="mt-1 text-sm text-muted">
          {showOutOfRange
            ? t("outOfRange", { min: fmt(opts.min_paise), max: fmt(opts.max_paise) })
            : bounds}
        </p>
      </fieldset>
      {opts.bonus_enabled && (
        <p className="mt-3 text-sm text-muted">
          {t("bonusNote", { days: BILLING.promoExpiryDays })}
        </p>
      )}
      <button
        type="button"
        disabled={!valid || busy}
        onClick={() => void start()}
        className="mt-4 rounded-sm bg-primary px-5 py-2 font-medium text-primary-fg disabled:opacity-60"
      >
        {valid && amount !== null ? t("pay", { amount: fmt(amount) }) : t("heading")}
      </button>
      {opts.provider === "razorpay" && <p className="mt-2 text-xs text-muted">{t("secure")}</p>}

      <div aria-live="polite" className="mt-4 space-y-3" data-testid="pay-status">
        {pay.step === "creating" && <p>{t("creating")}</p>}
        {pay.step === "checkout" && <p>{t("checkout")}</p>}
        {pay.step === "verifying" && <p>{t("verifying")}</p>}
        {pay.step === "pending" && (
          <>
            <p>{pay.slow ? t("stillPending") : t("pending")}</p>
            {pay.slow && (
              <button
                type="button"
                onClick={() => void settle(pay.order)}
                className="rounded-sm border border-border px-4 py-2 text-sm"
              >
                {t("checkAgain")}
              </button>
            )}
          </>
        )}
        {pay.step === "paid" && (
          <p className="font-medium" style={{ color: "var(--color-success)" }}>
            {pay.order.bonus_paise > 0
              ? t("paidBonus", {
                  amount: fmt(pay.order.amount_paise),
                  bonus: fmt(pay.order.bonus_paise),
                })
              : t("paid", { amount: fmt(pay.order.amount_paise) })}
          </p>
        )}
        {pay.step === "failed" && <p role="alert">{t("failed")}</p>}
        {pay.step === "dismissed" && <p>{t("dismissed")}</p>}
        {pay.step === "error" && <p role="alert">{t(`errors.${pay.key}`)}</p>}
        {pay.step === "dev" && (
          <div
            className="space-y-2 rounded-sm border-2 border-dashed p-3"
            style={{ borderColor: "var(--color-accent)" }}
            data-testid="dev-payment"
          >
            <p className="font-semibold">{t("devTitle")}</p>
            <p className="text-sm">{t("devNote")}</p>
            <p className="text-sm">
              {pay.order.bonus_paise > 0
                ? t("summaryBonus", {
                    amount: fmt(pay.order.amount_paise),
                    bonus: fmt(pay.order.bonus_paise),
                  })
                : t("summary", { amount: fmt(pay.order.amount_paise) })}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void simulate(pay.order, "captured")}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-fg"
              >
                {t("simulateSuccess")}
              </button>
              <button
                type="button"
                onClick={() => void simulate(pay.order, "failed")}
                className="rounded-sm border border-border px-4 py-2 text-sm"
              >
                {t("simulateFailure")}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
