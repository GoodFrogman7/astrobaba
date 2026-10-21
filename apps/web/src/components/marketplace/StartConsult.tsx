"use client";

import type { SessionKind } from "@astro/shared";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { Dialog } from "@/components/billing/Dialog";
import { useWallet } from "@/components/billing/useWallet";
import { Link, useRouter } from "@/i18n/navigation";
import { track } from "@/lib/analytics/client";
import { refreshWallet } from "@/lib/billing/client";
import { BILLING, minStartPaise } from "@/lib/billing/config";
import { IntentKeys } from "@/lib/billing/idempotency";
import { requestSession, type Outcome } from "@/lib/billing/start";
import { formatPaise } from "@/lib/marketplace/format";
import { SignIn } from "./SignIn";

/** The message key to show for a failed start, worded for the kind the user chose. */
export function outcomeKey(kind: SessionKind, key: Extract<Outcome, { kind: "message" }>["key"]) {
  if (kind === "chat") return key;
  if (key === "chatUnavailable") return "callUnavailable";
  if (key === "generic") return "callGeneric";
  return key;
}

/**
 * Start a chat or a voice call from a profile: same price, same checks (docs/api/billing.md;
 * calls: docs/api/portal.md §1). Signs in first if needed, explains a short balance with the
 * exact amount to add, and links to an already-open session instead of starting a second one.
 * The Call button is live when the astrologer takes calls; the API still answers
 * `409 call_unavailable` while the platform's voice_calls flag is off, and we say so.
 */
export function StartConsult({
  astrologerId,
  slug,
  name,
  pricePerMinPaise,
  chat,
  voice,
  compact = false,
}: {
  astrologerId: string;
  /** For the consult_cta_clicked analytics event only. */
  slug?: string;
  name: string;
  pricePerMinPaise: number;
  chat: boolean;
  voice: boolean;
  compact?: boolean;
}) {
  const t = useTranslations("billing.start");
  const locale = useLocale() as "en" | "hi";
  const router = useRouter();
  const wallet = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [kind, setKind] = useState<SessionKind>("chat");
  const last = useRef<{ kind: SessionKind; free: boolean }>({ kind: "chat", free: false });
  const keysRef = useRef<IntentKeys | null>(null);

  const w = wallet && wallet.signed_in ? wallet.wallet : null;
  const free = w?.free_session.enabled && w.free_session.eligible ? w.free_session : null;

  async function start(k: SessionKind, isFree: boolean) {
    last.current = { kind: k, free: isFree };
    setKind(k);
    keysRef.current ??= new IntentKeys();
    const keys = keysRef.current;
    if (wallet && !wallet.signed_in) return setOutcome({ kind: "signin" });
    setBusy(`${k}:${isFree}`);
    const r = await requestSession({
      astrologerId,
      kind: k,
      free: isFree,
      pricePerMinPaise,
      balancePaise: w ? w.total_paise : null,
      keys,
    });
    setBusy(null);
    if (r.ok) router.push(`/chat/${encodeURIComponent(r.id)}`);
    else setOutcome(r.outcome);
  }

  const primary = "rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg disabled:opacity-60";
  const outline =
    "rounded-sm border border-primary px-4 py-2 font-medium text-primary disabled:opacity-60";
  const off = "cursor-not-allowed opacity-60";
  const minAmount = formatPaise(minStartPaise(pricePerMinPaise), locale);
  const isBusy = (k: SessionKind, f: boolean) => busy === `${k}:${f}`;
  // consult_cta_clicked: where the button is (consult card or phone bar) and whether it is the
  // free offer; never anything about the visitor.
  const ctaClicked = (free: boolean) => {
    const source = `${compact ? "profile-bar" : "profile"}${free ? "-free" : ""}`;
    track(
      "consult_cta_clicked",
      slug && /^[a-z0-9-]{1,80}$/.test(slug) ? { source, astrologer_slug: slug } : { source },
    );
  };

  const paidButton = (k: SessionKind, enabled: boolean, style: string) => (
    <button
      type="button"
      disabled={!enabled || busy !== null}
      aria-describedby={enabled || compact ? undefined : `${k}-off`}
      onClick={() => {
        ctaClicked(false);
        void start(k, false);
      }}
      className={`${style} ${compact ? "" : "w-full"} ${enabled ? "" : off}`.trim()}
    >
      {isBusy(k, false) ? t("starting") : t(k)}
    </button>
  );

  return (
    <div className={compact ? "flex flex-wrap justify-end gap-2" : "space-y-3"}>
      {paidButton("chat", chat, primary)}
      {!compact && !chat && (
        <p id="chat-off" className="text-sm text-muted">
          {t("chatOff")}
        </p>
      )}
      {paidButton("call", voice, outline)}
      {!compact && !voice && (
        <p id="call-off" className="text-sm text-muted">
          {t("callOff")}
        </p>
      )}
      {!compact && (chat || voice) && (
        <p className="text-sm text-muted">
          {t("minBalance", { amount: minAmount, minutes: BILLING.minStartMinutes })}{" "}
          {t("partialMinute")}
        </p>
      )}
      {free && (chat || voice) && (
        <div className={compact ? "contents" : "flex flex-wrap gap-2 border-t border-border pt-3"}>
          {!compact && (
            <p className="w-full text-sm">{t("freeOffer", { minutes: free.minutes })}</p>
          )}
          {chat && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                ctaClicked(true);
                void start("chat", true);
              }}
              className="rounded-sm border border-primary px-4 py-2 text-sm font-medium text-primary disabled:opacity-60"
            >
              {t("freeChat", { minutes: free.minutes })}
            </button>
          )}
          {voice && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                ctaClicked(true);
                void start("call", true);
              }}
              className="rounded-sm border border-primary px-4 py-2 text-sm font-medium text-primary disabled:opacity-60"
            >
              {t("freeCall", { minutes: free.minutes })}
            </button>
          )}
        </div>
      )}
      <Dialog
        open={outcome !== null}
        onClose={() => setOutcome(null)}
        title={kind === "call" ? t("callDialogTitle", { name }) : t("dialogTitle", { name })}
      >
        {outcome?.kind === "signin" && (
          <>
            <p>{kind === "call" ? t("callSignIn") : t("signIn")}</p>
            <SignIn
              source="consult"
              onSignedIn={() => {
                setOutcome(null);
                void refreshWallet().then(() => start(last.current.kind, last.current.free));
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
        {outcome?.kind === "message" && <p role="alert">{t(outcomeKey(kind, outcome.key))}</p>}
      </Dialog>
    </div>
  );
}
