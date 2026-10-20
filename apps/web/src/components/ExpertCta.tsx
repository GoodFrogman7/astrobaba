import type { Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";

/**
 * Consultation call-to-action at the end of every tool (PLAN.md §5 Phase 2). Until vetted
 * astrologers are live (Phase 3) it says so plainly: no invented profiles, counts or timers.
 */
export async function ExpertCta({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "cta" });
  return (
    <section
      aria-labelledby="cta"
      className="mt-12 rounded-lg bg-primary px-6 py-6 text-primary-fg"
    >
      <h2 id="cta" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      <p className="mt-2 max-w-2xl leading-relaxed">{t("body")}</p>
      <p className="mt-3 text-sm opacity-90">{t("status")}</p>
    </section>
  );
}
