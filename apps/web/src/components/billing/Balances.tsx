"use client";

import { useLocale, useTranslations } from "next-intl";
import { BILLING } from "@/lib/billing/config";
import type { Wallet } from "@/lib/billing/types";
import { dateTimeIst, formatPaise } from "@/lib/marketplace/format";

/** Real and promo balances with the spending rule and every promo lot's expiry, in words. */
export function Balances({ wallet }: { wallet: Wallet }) {
  const t = useTranslations("billing.wallet");
  const locale = useLocale() as "en" | "hi";
  const lots = wallet.promo_lots.filter((l) => l.remaining_paise > 0);
  return (
    <section aria-labelledby="balances" className="rounded-md border border-border bg-surface p-5">
      <h2 id="balances" className="text-lg font-semibold">
        {t("balances")}
      </h2>
      <p className="mt-3">
        <span className="block text-sm text-muted">{t("total")}</span>
        <span className="text-3xl font-semibold tabular-nums" data-testid="wallet-total">
          {formatPaise(wallet.total_paise, locale)}
        </span>
      </p>
      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <dt className="font-medium">{t("real")}</dt>
          <dd className="text-xl tabular-nums">{formatPaise(wallet.real_paise, locale)}</dd>
          <dd className="mt-1 text-sm text-muted">
            {t("realHelp", { days: BILLING.realCreditExpiryDays })}
          </dd>
        </div>
        <div>
          <dt className="font-medium">{t("promo")}</dt>
          <dd className="text-xl tabular-nums">{formatPaise(wallet.promo_paise, locale)}</dd>
          <dd className="mt-1 text-sm text-muted">{t("promoHelp")}</dd>
        </div>
      </dl>
      <p className="mt-4 text-sm">{t("spendOrder")}</p>
      {lots.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-medium">{t("lots")}</h3>
          <ul className="mt-1 space-y-1 text-sm">
            {lots.map((l) => (
              <li key={l.id}>
                {t("lot", {
                  amount: formatPaise(l.remaining_paise, locale),
                  date: dateTimeIst(l.expires_at, locale),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
      {wallet.free_session.enabled && wallet.free_session.eligible && (
        <p className="mt-4 text-sm">{t("freeOffer", { minutes: wallet.free_session.minutes })}</p>
      )}
    </section>
  );
}
