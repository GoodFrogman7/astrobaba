import { useLocale, useTranslations } from "next-intl";
import { rupeesPerMin } from "@/lib/marketplace/format";
import type { AstrologerProfile } from "@/lib/marketplace/types";
import { PresenceBadge } from "./Presence";

/**
 * Consult card: sticky beside the profile on wide screens. Consultations start in Phase 4, so
 * the buttons are disabled and say so; no fake availability or countdowns.
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
        {rupeesPerMin(p.price_per_min_paise, locale)}{" "}
        <span className="text-base font-normal text-muted">{t("perMin")}</span>
      </p>
      <div className="mt-2">
        <PresenceBadge presence={p.presence} wait={p.wait_minutes} />
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          disabled
          aria-describedby="consult-soon"
          className="flex-1 cursor-not-allowed rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg opacity-60"
        >
          {t("chat")}
        </button>
        <button
          type="button"
          disabled
          aria-describedby="consult-soon"
          className="flex-1 cursor-not-allowed rounded-sm border border-primary px-4 py-2 font-medium text-primary opacity-60"
        >
          {t("call")}
        </button>
      </div>
      <p id="consult-soon" className="mt-3 text-sm text-muted">
        {t("soon")}
      </p>
      <p className="mt-2 text-xs text-muted">{t("billing")}</p>
    </section>
  );
}

/** Bottom bar on phones so price and the consult action stay in reach. */
export function MobileConsultBar({ p }: { p: AstrologerProfile }) {
  const t = useTranslations("market.consult");
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
          <span className="block text-xs text-muted">{t("soon")}</span>
        </p>
        <button
          type="button"
          disabled
          className="cursor-not-allowed rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg opacity-60"
        >
          {t("chat")}
        </button>
      </div>
    </div>
  );
}
