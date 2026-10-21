"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Link } from "@/i18n/navigation";
import { call } from "@/lib/billing/client";
import type { TxnPage, WalletTxn } from "@/lib/billing/types";
import { dateTimeIst, formatPaise } from "@/lib/marketplace/format";

/** Newest first; one line per consultation (the API groups per-minute charges). */
export function TransactionList() {
  const t = useTranslations("billing.txn");
  const [items, setItems] = useState<WalletTxn[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = useCallback(async (after: string | null) => {
    setState("loading");
    const q = new URLSearchParams({ limit: "20" });
    if (after) q.set("cursor", after);
    const r = await call<TxnPage>(`/api/wallet/transactions?${q}`);
    if (!r.ok) return setState("error");
    setItems((prev) => {
      const seen = new Set(prev.map((i) => i.id));
      return [...(after ? prev : []), ...r.data.items.filter((i) => !after || !seen.has(i.id))];
    });
    setCursor(r.data.next_cursor);
    setState("ready");
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(null);
  }, [load]);

  return (
    <section aria-labelledby="txns" className="space-y-3">
      <h2 id="txns" className="text-lg font-semibold">
        {t("heading")}
      </h2>
      {state === "ready" && items.length === 0 && <p className="text-muted">{t("empty")}</p>}
      {items.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {items.map((i) => (
            <TxnRow key={i.id} txn={i} />
          ))}
        </ul>
      )}
      <div aria-live="polite">{state === "error" && <p>{t("error")}</p>}</div>
      {cursor && state !== "loading" && (
        <button
          type="button"
          onClick={() => void load(cursor)}
          className="rounded-sm border border-border px-4 py-2 text-sm"
        >
          {t("loadMore")}
        </button>
      )}
    </section>
  );
}

/** The row's label key: purchases say what was bought when the row data says so. */
export function txnLabelKey(txn: Pick<WalletTxn, "kind" | "product">): string {
  if (txn.kind === "purchase") {
    if (txn.product === "report") return "kinds.purchaseReport";
    if (txn.product === "ai_question") return "kinds.purchaseAi";
    return "kinds.purchase";
  }
  return `kinds.${txn.kind}`;
}

function TxnRow({ txn }: { txn: WalletTxn }) {
  const t = useTranslations("billing.txn");
  const locale = useLocale() as "en" | "hi";
  const key = txnLabelKey(txn);
  const label =
    txn.kind === "consultation" && txn.astrologer
      ? t("kinds.consultationWith", { name: txn.astrologer.display_name })
      : t.has(key)
        ? t(key)
        : txn.kind;
  const split = txn.real_paise !== 0 && txn.promo_paise !== 0;
  return (
    <li className="flex flex-wrap items-start justify-between gap-2 p-4">
      <div className="min-w-0">
        <p className="font-medium">
          {txn.kind === "consultation" && txn.astrologer ? (
            <Link href={`/astrologers/${txn.astrologer.slug}`} className="hover:underline">
              {label}
            </Link>
          ) : (
            label
          )}
        </p>
        <p className="text-sm text-muted">{dateTimeIst(txn.created_at, locale)}</p>
        {split && (
          <p className="text-sm text-muted">
            {t("split", {
              real: formatPaise(Math.abs(txn.real_paise), locale),
              promo: formatPaise(Math.abs(txn.promo_paise), locale),
            })}
          </p>
        )}
        {txn.session_id && (
          <Link href={`/chat/${txn.session_id}`} className="text-sm text-accent underline">
            {t("viewChat")}
          </Link>
        )}
        {txn.kind === "purchase" && txn.product === "report" && (
          <Link href="/account/reports" className="text-sm text-accent underline">
            {t("viewReports")}
          </Link>
        )}
      </div>
      <p
        className="font-semibold tabular-nums"
        style={{ color: txn.amount_paise > 0 ? "var(--color-success)" : undefined }}
      >
        {formatPaise(txn.amount_paise, locale, { signed: true })}
      </p>
    </li>
  );
}
