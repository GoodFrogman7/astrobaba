import { useLocale, useTranslations } from "next-intl";
import { formatPaise } from "@/lib/marketplace/format";
import type { AstrologerProfile } from "@/lib/marketplace/types";
import { PresenceBadge } from "./Presence";
import { StartConsult } from "./StartConsult";

/**
 * Consult card: sticky beside the profile on wide screens. Chat and voice calls start from here
 * at the same per-minute price, each when the astrologer offers it (calls also need the
 * platform's voice_calls flag, which the API enforces). No fake availability or countdowns.
 */
export function ConsultCard({ p }: { p: AstrologerProfile }) {
  const t = useTranslations("market.consult");
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
        {formatPaise(p.price_per_min_paise, locale)}{" "}
        <span className="text-base font-normal text-muted">{t("perMin")}</span>
      </p>
      <div className="mt-2">
        <PresenceBadge presence={p.presence} wait={p.wait_minutes} />
      </div>
      <div className="mt-4">
        <StartConsult
          astrologerId={p.id}
          slug={p.slug}
          name={p.display_name}
          pricePerMinPaise={p.price_per_min_paise}
          chat={p.consult.chat_enabled}
          voice={p.consult.call_enabled}
        />
      </div>
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
          <span className="font-semibold">{formatPaise(p.price_per_min_paise, locale)}</span>{" "}
          {t("perMin")}
          {!p.consult.chat_enabled && (
            <span className="block text-xs text-muted">{tb("chatOff")}</span>
          )}
          {!p.consult.call_enabled && (
            <span className="block text-xs text-muted">{tb("callOff")}</span>
          )}
        </p>
        <StartConsult
          astrologerId={p.id}
          slug={p.slug}
          name={p.display_name}
          pricePerMinPaise={p.price_per_min_paise}
          chat={p.consult.chat_enabled}
          voice={p.consult.call_enabled}
          compact
        />
      </div>
    </div>
  );
}
