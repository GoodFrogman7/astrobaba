import { useLocale, useTranslations } from "next-intl";
import { rupeesPerMin } from "@/lib/marketplace/format";
import type { AstrologerProfile } from "@/lib/marketplace/types";
import { PresenceBadge } from "./Presence";
import { StartChat } from "./StartChat";

/**
 * Consult card: sticky beside the profile on wide screens. Chat starts from here when the
 * astrologer has chat enabled; voice calls come in Phase 5, so that button is disabled and says
 * so. No fake availability or countdowns.
 */
export function ConsultCard({ p }: { p: AstrologerProfile }) {
  const t = useTranslations("market.consult");
  const tb = useTranslations("billing.start");
  const locale = useLocale() as "en" | "hi";
  return (
    <section
      aria-labelledby="consult"
      className="rounded-md border border-border bg-surface p-5 lg:sticky lg:top-4"
      data-testid="consult-card"
    >
      <h2 id="consult" className="text-lg font-semibold">
        {t("title", { name: p.display_name })}
      </h2>
      <p className="mt-2 text-2xl font-semibold">
        {rupeesPerMin(p.price_per_min_paise, locale)}{" "}
        <span className="text-base font-normal text-muted">{t("perMin")}</span>
      </p>
      <div className="mt-2">
        <PresenceBadge presence={p.presence} wait={p.wait_minutes} />
      </div>
      <div className="mt-4">
        {p.consult.chat_enabled ? (
          <StartChat
            astrologerId={p.id}
            name={p.display_name}
            pricePerMinPaise={p.price_per_min_paise}
          />
        ) : (
          <>
            <button
              type="button"
              disabled
              aria-describedby="chat-off"
              className="w-full cursor-not-allowed rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg opacity-60"
            >
              {t("chat")}
            </button>
            <p id="chat-off" className="mt-2 text-sm text-muted">
              {tb("chatOff")}
            </p>
          </>
        )}
      </div>
      <button
        type="button"
        disabled
        aria-describedby="call-soon"
        className="mt-3 w-full cursor-not-allowed rounded-sm border border-primary px-4 py-2 font-medium text-primary opacity-60"
      >
        {t("call")}
      </button>
      <p id="call-soon" className="mt-2 text-sm text-muted">
        {t("callSoon")}
      </p>
      <p className="mt-2 text-xs text-muted">{t("billing")}</p>
    </section>
  );
}

/** Bottom bar on phones so price and the consult action stay in reach. */
export function MobileConsultBar({ p }: { p: AstrologerProfile }) {
  const t = useTranslations("market.consult");
  const tb = useTranslations("billing.start");
  const locale = useLocale() as "en" | "hi";
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-10 border-t border-border bg-bg px-4 py-3 lg:hidden"
      data-testid="consult-bar"
    >
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <p className="text-sm">
          <span className="font-semibold">{rupeesPerMin(p.price_per_min_paise, locale)}</span>{" "}
          {t("perMin")}
          {!p.consult.chat_enabled && (
            <span className="block text-xs text-muted">{tb("chatOff")}</span>
          )}
        </p>
        {p.consult.chat_enabled ? (
          <StartChat
            astrologerId={p.id}
            name={p.display_name}
            pricePerMinPaise={p.price_per_min_paise}
            compact
          />
        ) : (
          <button
            type="button"
            disabled
            className="cursor-not-allowed rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg opacity-60"
          >
            {t("chat")}
          </button>
        )}
      </div>
    </div>
  );
}
