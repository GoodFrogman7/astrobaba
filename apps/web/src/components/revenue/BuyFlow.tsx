"use client";

import { BRAND_NAME, type ReportLanguage, type ReportSku } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { useWallet } from "@/components/billing/useWallet";
import { SignIn } from "@/components/marketplace/SignIn";
import { Link } from "@/i18n/navigation";
import { call, refreshWallet } from "@/lib/billing/client";
import { IntentKeys } from "@/lib/billing/idempotency";
import { pollOrder } from "@/lib/billing/poll";
import { loadRazorpay, type RazorpaySuccess } from "@/lib/billing/razorpay";
import type { RechargeOptions } from "@/lib/billing/types";
import { formatPaise, shortDate } from "@/lib/marketplace/format";
import { BUSY, placeOrder, stateFor, type BuyState, type PayWith } from "@/lib/revenue/buy";
import { KUNDLIS_PER_SKU } from "@/lib/revenue/config";
import type { ReportOrder, ReportProduct, SavedKundli } from "@/lib/revenue/types";
import { useKundlis } from "./useKundlis";

/**
 * Buying a report (docs/api/revenue.md §2.1): which report, which saved kundli(s), language,
 * optional email, then wallet or Razorpay. Prices come from the API at the moment of buying.
 * Wallet orders are paid at once; Razorpay orders are paid in Checkout (or the dev simulator)
 * and confirmed by the webhook, so we poll the order. One Idempotency-Key per intent.
 */
export function BuyFlow({
  initialSku,
  products: initialProducts,
}: {
  initialSku: ReportSku;
  products: ReportProduct[] | null;
}) {
  const t = useTranslations("revenue.buy");
  const tr = useTranslations("revenue");
  const locale = useLocale() as "en" | "hi";
  const fmt = (p: number) => formatPaise(p, locale);
  const wallet = useWallet();
  const signedIn = wallet?.signed_in === true;
  const kundlis = useKundlis(signedIn);
  const [products, setProducts] = useState<ReportProduct[] | null>(initialProducts);
  const [sku, setSku] = useState<ReportSku>(initialSku);
  const [picked, setPicked] = useState<[string, string]>(["", ""]);
  const [language, setLanguage] = useState<ReportLanguage>(locale);
  const [email, setEmail] = useState("");
  const [payWith, setPayWith] = useState<PayWith>("wallet");
  const [state, setState] = useState<BuyState>({ step: "idle" });
  const keysRef = useRef<IntentKeys | null>(null);
  const alive = useRef(true);
  const id = useId();

  useEffect(() => {
    alive.current = true;
    // The current price at the moment of buying (the page itself is cached for a few minutes).
    void call<{ items: ReportProduct[] }>("/api/reports/products").then((r) => {
      if (alive.current && r.ok && Array.isArray(r.data.items)) setProducts(r.data.items);
    });
    return () => {
      alive.current = false;
    };
  }, []);

  const product = products?.find((p) => p.sku === sku) ?? null;
  const need = KUNDLIS_PER_SKU[sku];
  const kundliIds = picked.slice(0, need);
  const balance = wallet?.signed_in ? wallet.wallet.total_paise : null;
  const busy = BUSY.includes(state.step);
  const short = product && balance !== null ? Math.max(0, product.price_paise - balance) : 0;

  if (wallet === undefined) return <p className="text-muted">{t("loading")}</p>;
  if (wallet === null) return <p role="alert">{t("errors.generic")}</p>;
  if (!wallet.signed_in || state.step === "signin")
    return (
      <div className="space-y-3">
        <p>{t("signIn")}</p>
        <SignIn
          onSignedIn={() => {
            setState({ step: "idle" });
            void refreshWallet();
          }}
        />
      </div>
    );

  async function settle(order: ReportOrder) {
    setState({ step: "pending", order, slow: false });
    const r = await pollOrder<ReportOrder>(
      async () => {
        const res = await call<ReportOrder>(`/api/reports/orders/${order.id}`);
        return res.ok ? res.data : null;
      },
      { cancelled: () => !alive.current },
    );
    if (!alive.current) return;
    if (r.order?.status === "paid") {
      keysRef.current?.done();
      setState({ step: "paid", order: r.order });
    } else if (r.order?.status === "failed") {
      keysRef.current?.done();
      setState({ step: "failed" });
    } else setState({ step: "pending", order, slow: true });
  }

  async function checkout(order: ReportOrder) {
    const opts = await call<RechargeOptions>("/api/wallet/recharge-options");
    if (!alive.current) return;
    if (opts.ok && opts.data.provider === "fake") return setState({ step: "dev", order });
    setState({ step: "checkout", order });
    let Rzp;
    try {
      Rzp = await loadRazorpay();
    } catch {
      return setState({ step: "message", key: "script" });
    }
    new Rzp({
      key: order.key_id ?? (opts.ok ? opts.data.key_id : ""),
      order_id: order.provider_order_id ?? "",
      amount: order.price_paise,
      currency: "INR",
      name: BRAND_NAME,
      description: tr(`sku.${order.sku}`),
      handler: (res: RazorpaySuccess) => void verified(order, res),
      modal: {
        ondismiss: () => setState((s) => (s.step === "checkout" ? { step: "dismissed" } : s)),
      },
    }).open();
  }

  async function verified(order: ReportOrder, res: RazorpaySuccess) {
    setState({ step: "verifying", order });
    await call(`/api/reports/orders/${order.id}/checkout-result`, {
      method: "POST",
      body: {
        provider_payment_id: res.razorpay_payment_id,
        provider_signature: res.razorpay_signature,
      },
    });
    await settle(order);
  }

  async function simulate(order: ReportOrder, outcome: "captured" | "failed") {
    setState({ step: "verifying", order });
    await call(`/api/dev/payments/${order.id}/simulate`, { method: "POST", body: { outcome } });
    await settle(order);
  }

  async function buy() {
    if (!product) return;
    keysRef.current ??= new IntentKeys();
    setState({ step: "creating" });
    const outcome = await placeOrder(
      { sku, language, kundliIds, payWith, email },
      { price: product.price_paise, balance, keys: keysRef.current, languages: product.languages },
    );
    if (!alive.current) return;
    if (outcome.kind === "paid") void refreshWallet();
    if (outcome.kind === "checkout") return checkout(outcome.order);
    setState(stateFor(outcome));
  }

  const reset = () => setState((s) => (BUSY.includes(s.step) ? s : { step: "idle" }));
  const invalid = state.step === "invalid" ? state.errors : [];

  if (state.step === "paid")
    return (
      <div className="space-y-3" role="status" data-testid="buy-paid">
        <p className="font-medium" style={{ color: "var(--color-success)" }}>
          {t("paid", { amount: fmt(state.order.price_paise) })}
        </p>
        <p>{t("paidNext")}</p>
        <Link
          href="/account/reports"
          className="inline-block rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
        >
          {t("myReports")}
        </Link>
      </div>
    );

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void buy();
      }}
      className="space-y-5"
    >
      <fieldset disabled={busy} className="space-y-5">
        <fieldset>
          <legend className="text-sm font-medium">{t("which")}</legend>
          <div className="mt-2 grid gap-2">
            {(products ?? []).map((p) => (
              <label key={p.sku} className="flex items-start gap-2">
                <input
                  type="radio"
                  name={`${id}-sku`}
                  value={p.sku}
                  checked={sku === p.sku}
                  onChange={() => {
                    setSku(p.sku);
                    reset();
                  }}
                  className="mt-1"
                />
                <span>
                  {tr(`sku.${p.sku}`)} · <span className="tabular-nums">{fmt(p.price_paise)}</span>
                </span>
              </label>
            ))}
          </div>
          {!product && <p className="mt-2 text-sm">{t("errors.noPrice")}</p>}
        </fieldset>

        <KundliChoice
          need={need}
          kundlis={kundlis}
          picked={picked}
          onPick={(i, v) => {
            setPicked((p) => (i === 0 ? [v, p[1]] : [p[0], v]));
            reset();
          }}
          error={
            invalid.includes("kundliCount")
              ? t("errors.kundliCount", { count: need })
              : invalid.includes("kundliDistinct")
                ? t("errors.kundliDistinct")
                : null
          }
        />

        <fieldset>
          <legend className="text-sm font-medium">{t("language")}</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {(product?.languages ?? ["en", "hi"]).map((l) => (
              <label key={l} className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`${id}-lang`}
                  value={l}
                  checked={language === l}
                  onChange={() => {
                    setLanguage(l);
                    reset();
                  }}
                />
                {tr(`languages.${l}`)}
              </label>
            ))}
          </div>
        </fieldset>

        <div>
          <label htmlFor={`${id}-email`} className="block text-sm font-medium">
            {t("email")}
          </label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={254}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              reset();
            }}
            aria-describedby={`${id}-email-hint`}
            aria-invalid={invalid.includes("email") || undefined}
            className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
          />
          <p id={`${id}-email-hint`} className="mt-1 text-sm text-muted">
            {invalid.includes("email") ? t("errors.email") : t("emailHint")}
          </p>
        </div>

        <fieldset>
          <legend className="text-sm font-medium">{t("payWith")}</legend>
          <div className="mt-2 grid gap-2">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name={`${id}-pay`}
                value="wallet"
                checked={payWith === "wallet"}
                onChange={() => {
                  setPayWith("wallet");
                  reset();
                }}
                className="mt-1"
              />
              <span>
                {t("wallet")}
                {balance !== null && (
                  <span className="block text-sm text-muted tabular-nums">
                    {t("balance", { amount: fmt(balance) })}
                  </span>
                )}
                {payWith === "wallet" && short > 0 && (
                  <span className="block text-sm">{t("short", { amount: fmt(short) })}</span>
                )}
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name={`${id}-pay`}
                value="razorpay"
                checked={payWith === "razorpay"}
                onChange={() => {
                  setPayWith("razorpay");
                  reset();
                }}
                className="mt-1"
              />
              <span>
                {t("razorpay")}
                <span className="block text-sm text-muted">{t("razorpayNote")}</span>
              </span>
            </label>
          </div>
        </fieldset>
      </fieldset>

      <p className="text-sm text-muted">{t("refundNote")}</p>
      <button
        type="submit"
        disabled={busy || !product}
        className="rounded-sm bg-primary px-5 py-2 font-medium text-primary-fg disabled:opacity-60"
      >
        {product ? t("pay", { amount: fmt(product.price_paise) }) : t("payNoPrice")}
      </button>

      <div aria-live="polite" className="space-y-3" data-testid="buy-status">
        {state.step === "creating" && <p>{t("creating")}</p>}
        {state.step === "checkout" && <p>{t("checkout")}</p>}
        {state.step === "verifying" && <p>{t("verifying")}</p>}
        {state.step === "pending" && (
          <>
            <p>{state.slow ? t("stillPending") : t("pending")}</p>
            {state.slow && (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void settle(state.order)}
                  className="rounded-sm border border-border px-4 py-2 text-sm"
                >
                  {t("checkAgain")}
                </button>
                <Link href="/account/reports" className="px-1 py-2 text-sm text-accent underline">
                  {t("myReports")}
                </Link>
              </div>
            )}
          </>
        )}
        {state.step === "failed" && <p role="alert">{t("failed")}</p>}
        {state.step === "dismissed" && <p>{t("dismissed")}</p>}
        {state.step === "invalid" && <p role="alert">{t("errors.fix")}</p>}
        {state.step === "message" && <p role="alert">{t(`errors.${state.key}`)}</p>}
        {state.step === "insufficient" && (
          <div role="alert" className="space-y-2" data-testid="buy-insufficient">
            <p>
              {t("insufficient", {
                required: fmt(state.required),
                available: fmt(state.available),
              })}
            </p>
            <Link
              href={`/wallet?amount=${state.suggest}`}
              className="inline-block font-medium text-accent underline"
            >
              {t("addMoney", { amount: fmt(state.suggest) })}
            </Link>
            <p className="text-sm text-muted">{t("orRazorpay")}</p>
          </div>
        )}
        {state.step === "dev" && (
          <div
            className="space-y-2 rounded-sm border-2 border-dashed p-3"
            style={{ borderColor: "var(--color-accent)" }}
            data-testid="dev-payment"
          >
            <p className="font-semibold">{t("devTitle")}</p>
            <p className="text-sm">{t("devNote")}</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void simulate(state.order, "captured")}
                className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-fg"
              >
                {t("simulateSuccess")}
              </button>
              <button
                type="button"
                onClick={() => void simulate(state.order, "failed")}
                className="rounded-sm border border-border px-4 py-2 text-sm"
              >
                {t("simulateFailure")}
              </button>
            </div>
          </div>
        )}
      </div>
    </form>
  );
}

/** One radio list (kundli report) or two pickers (matching: person 1 and person 2). */
export function KundliChoice({
  need,
  kundlis,
  picked,
  onPick,
  error,
}: {
  need: number;
  kundlis: SavedKundli[] | null | undefined;
  picked: [string, string];
  onPick: (index: 0 | 1, id: string) => void;
  error: string | null;
}) {
  const t = useTranslations("revenue.buy");
  const locale = useLocale() as "en" | "hi";
  const id = useId();
  const label = (k: SavedKundli) => `${k.name} · ${shortDate(`${k.birth.date}T12:00:00Z`, locale)}`;

  let body;
  if (kundlis === undefined) body = <p className="text-sm text-muted">{t("kundlisLoading")}</p>;
  else if (kundlis === null) body = <p className="text-sm">{t("errors.kundlis")}</p>;
  else if (kundlis.length < need)
    body = (
      <p className="text-sm" data-testid="no-kundlis">
        {kundlis.length === 0 ? t("noKundlis") : t("needTwo")}{" "}
        <Link href="/kundli" className="text-accent underline">
          {t("createKundli")}
        </Link>
      </p>
    );
  else if (need === 1)
    body = (
      <div className="mt-2 grid gap-2">
        {kundlis.map((k) => (
          <label key={k.id} className="flex items-center gap-2">
            <input
              type="radio"
              name={`${id}-k`}
              value={k.id}
              checked={picked[0] === k.id}
              onChange={() => onPick(0, k.id)}
            />
            {label(k)}
          </label>
        ))}
      </div>
    );
  else
    body = (
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        {([0, 1] as const).map((i) => (
          <label key={i} className="block text-sm">
            {t(i === 0 ? "person1" : "person2")}
            <select
              value={picked[i]}
              onChange={(e) => onPick(i, e.target.value)}
              className="mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2"
            >
              <option value="">{t("choose")}</option>
              {kundlis.map((k) => (
                <option key={k.id} value={k.id} disabled={picked[i === 0 ? 1 : 0] === k.id}>
                  {label(k)}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    );

  return (
    <fieldset aria-invalid={error ? true : undefined}>
      <legend className="text-sm font-medium">
        {need === 2 ? t("kundlisTwo") : t("kundlisOne")}
      </legend>
      {body}
      {error && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </fieldset>
  );
}
