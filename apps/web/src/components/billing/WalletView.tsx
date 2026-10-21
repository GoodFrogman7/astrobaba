"use client";

import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { SignIn } from "@/components/marketplace/SignIn";
import { prefillFromQuery } from "@/lib/billing/amount";
import { refreshWallet } from "@/lib/billing/client";
import { BILLING } from "@/lib/billing/config";
import { Balances } from "./Balances";
import { RechargePanel } from "./RechargePanel";
import { TransactionList } from "./TransactionList";
import { useWallet } from "./useWallet";

/** /wallet: balances, recharge and history for the signed-in user (client-only data). */
export function WalletView() {
  const t = useTranslations("billing.wallet");
  const wallet = useWallet();
  const params = useSearchParams();
  const [txnVersion, setTxnVersion] = useState(0);
  const prefill = prefillFromQuery(params.get("amount"), {
    min_paise: BILLING.recharge.minPaise,
    max_paise: BILLING.recharge.maxPaise,
  });

  if (wallet === undefined) return <p className="text-muted">{t("loading")}</p>;
  if (wallet === null)
    return (
      <div className="space-y-3" role="alert">
        <p>{t("error")}</p>
        <button
          type="button"
          onClick={() => void refreshWallet()}
          className="rounded-sm border border-border px-4 py-2 text-sm"
        >
          {t("retry")}
        </button>
      </div>
    );
  if (!wallet.signed_in)
    return (
      <div className="space-y-3">
        <p>{t("signIn")}</p>
        <SignIn onSignedIn={() => void refreshWallet()} />
      </div>
    );
  return (
    <div className="space-y-8">
      <Balances wallet={wallet.wallet} />
      <RechargePanel prefillPaise={prefill} onPaid={() => setTxnVersion((v) => v + 1)} />
      <TransactionList key={txnVersion} />
    </div>
  );
}
