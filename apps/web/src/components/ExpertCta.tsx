import type { Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { featuredAstrologers } from "@/lib/marketplace/data";
import { AstrologerCard } from "./marketplace/AstrologerCard";

/**
 * Consultation call-to-action at the end of every tool (PLAN.md §5 Phase 2/3): up to three
 * public, verified astrologers. When none are public yet, or the API is down, it says plainly that
 * consultations are open (chat, and voice calls where the astrologer and the platform offer them)
 * without inventing profiles, counts or timers. The list is cached for five
 * minutes, so presence (which changes faster) is not shown here.
 */
export async function ExpertCta({ locale }: { locale: Locale }) {
  const experts = await featuredAstrologers();
  if (experts.length === 0) {
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
  const t = await getTranslations({ locale, namespace: "market.experts" });
  return (
    <section aria-labelledby="cta" className="mt-12" data-testid="expert-cards">
      <h2 id="cta" className="text-xl font-semibold">
        {t("heading")}
      </h2>
      <p className="mt-1 text-sm text-muted">{t("note")}</p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {experts.map((a) => (
          <li key={a.id}>
            <AstrologerCard a={a} showPresence={false} />
          </li>
        ))}
      </ul>
      <Link
        href="/astrologers"
        className="mt-4 inline-block py-2 font-medium text-accent underline"
      >
        {t("all")}
      </Link>
    </section>
  );
}
