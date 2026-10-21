"use client";

import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { formatPaise } from "@/lib/marketplace/format";
import { useWallet } from "./useWallet";

/**
 * Header wallet link with the balance, shown only to signed-in visitors. The data is fetched
 * after mount (public pages stay static and cookie-free), and the slot keeps a fixed size from
 * the first paint so the header never shifts when the balance arrives.
 */
export function WalletNavLink() {
  const t = useTranslations("billing.nav");
  const locale = useLocale() as "en" | "hi";
  const wallet = useWallet();
  const amount = wallet?.signed_in ? formatPaise(wallet.wallet.total_paise, locale) : null;
  return (
    <span
      className="inline-flex h-9 min-w-[5.5rem] items-center justify-end"
      data-testid="wallet-slot"
    >
      {amount && (
        <Link
          href="/wallet"
          aria-label={t("balance", { amount })}
          className="rounded-sm border border-border px-3 py-1.5 text-sm tabular-nums hover:bg-surface"
        >
          {amount}
        </Link>
      )}
    </span>
  );
}
