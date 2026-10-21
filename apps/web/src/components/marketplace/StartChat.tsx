"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import { useWallet } from "@/components/billing/useWallet";
import { Link, useRouter } from "@/i18n/navigation";
import { call, refreshWallet } from "@/lib/billing/client";
import { BILLING, minStartPaise } from "@/lib/billing/config";
import { IntentKeys } from "@/lib/billing/idempotency";
import { outcomeFor, type Outcome } from "@/lib/billing/start";
import { formatPaise } from "@/lib/marketplace/format";
import { SignIn } from "./SignIn";

/**
 * Start a chat from a profile. Signs in first if needed, explains a short balance with the
 * exact amount to add, and links to an already-open chat instead of starting a second one.
 */
export function StartChat({
  astrologerId,
  name,
  pricePerMinPaise,
  compact = false,
}: {
  astrologerId: string;
  name: string;
  pricePerMinPaise: number;
  compact?: boolean;
}) {
  const t = useTranslations("billing.start");
  const locale = useLocale() as "en" | "hi";
  const router = useRouter();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const lastFree = useRef(false);
  const keysRef = useRef<IntentKeys | null>(null);

  const w = wallet && wallet.signed_in ? wallet.wallet : null;
  const free = w?.free_session.enabled && w.free_session.eligible ? w.free_session : null;

  async function start(isFree: boolean) {
    lastFree.current = isFree;
    keysRef.current ??= new IntentKeys();
    const keys = keysRef.current;
    if (wallet && !wallet.signed_in) return setOutcome({ kind: "signin" });
    setBusy(true);
    const r = await call<{ id: string }>("/api/sessions", {
      method: "POST",
      body: { astrologer_id: astrologerId, kind: "chat", free: isFree },
      idempotencyKey: keys.for(`${astrologerId}:${isFree ? "free" : "paid"}`),
    });
    setBusy(false);
    if (r.ok) {
      keys.done();
      router.push(`/chat/${encodeURIComponent(r.data.id)}`);
      return;
    }
    // A network error keeps the key: pressing again retries the same request.
    if (r.status !== 0) keys.done();
    setOutcome(
      outcomeFor(r.status, r.error, {
        pricePerMinPaise,
        balancePaise: w ? w.total_paise : null,
      }),
    );
  }

  const primary = "rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60";
  const minAmount = formatPaise(minStartPaise(pricePerMinPaise), locale);

  return (
    <div className={compact ? "flex gap-2" : "space-y-3"}>
      <button
        type="button"
        disabled={busy}
        onClick={() => void start(false)}
        className={compact ? primary : `${primary} w-full`}
      >
        {busy ? t("starting") : t("chat")}
      </button>
      {!compact && (
        <p className="text-sm text-muted">
          {t("minBalance", { amount: minAmount, minutes: BILLING.minStartMinutes })}{" "}
          {t("partialMinute")}
        </p>
      )}
      {free && (
        <div className={compact ? "" : "space-y-2 border-t border-border pt-3"}>
          {!compact && <p className="text-sm">{t("freeOffer", { minutes: free.minutes })}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void start(true)}
            className="rounded-sm border border-primary px-4 py-2 text-sm font-medium text-primary disabled:opacity-60"
          >
            {t("freeChat", { minutes: free.minutes })}
          </button>
        </div>
      )}
      <Dialog
        open={outcome !== null}
        onClose={() => setOutcome(null)}
        title={t("dialogTitle", { name })}
      >
        {outcome?.kind === "signin" && (
          <>
            <p>{t("signIn")}</p>
            <SignIn
              onSignedIn={() => {
                setOutcome(null);
                void refreshWallet().then(() => start(lastFree.current));
              }}
            />
          </>
        )}
        {outcome?.kind === "insufficient" && (
          <>
            <p>
              {t("insufficient", {
                minutes: outcome.minutes,
                price: formatPaise(pricePerMinPaise, locale),
                required: formatPaise(outcome.required, locale),
              })}
            </p>
            <p>
              <Link
                href={`/wallet?amount=${outcome.suggest}`}
                className="font-medium text-accent underline"
              >
                {t("rechargeLink", { amount: formatPaise(outcome.suggest, locale) })}
              </Link>
            </p>
          </>
        )}
        {outcome?.kind === "open" && (
          <>
            <p>{t("sessionOpen")}</p>
            {outcome.sessionId && (
              <p>
                <Link
                  href={`/chat/${encodeURIComponent(outcome.sessionId)}`}
                  className="font-medium text-accent underline"
                >
                  {t("openSession")}
                </Link>
              </p>
            )}
          </>
        )}
        {outcome?.kind === "message" && <p role="alert">{t(outcome.key)}</p>}
      </Dialog>
    </div>
  );
}
