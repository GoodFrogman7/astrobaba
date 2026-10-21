import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { rupeesPerMin } from "@/lib/marketplace/format";
import { languageName, skillName } from "@/lib/marketplace/taxonomy";
import type { AstrologerCard as Card } from "@/lib/marketplace/types";
import { Avatar } from "./Avatar";
import { DemoBadge } from "./DemoBadge";
import { PresenceBadge } from "./Presence";
import { RatingText } from "./RatingText";

/** Directory card. `showPresence` is false where the data may be cached (expert cards). */
export function AstrologerCard({ a, showPresence = true }: { a: Card; showPresence?: boolean }) {
  const t = useTranslations("market.card");
  const locale = useLocale() as "en" | "hi";
  return (
    <article
      className="flex h-full flex-col rounded-md border border-border bg-surface p-4"
      data-testid="astrologer-card"
    >
      <div className="flex items-start gap-3">
        <Avatar name={a.display_name} />
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold leading-snug">
            <Link href={`/astrologers/${a.slug}`} className="hover:underline">
              {a.display_name}
            </Link>
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            {t("experience", { years: a.experience_years })}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <RatingText rating={a.rating} />
            {a.is_demo && <DemoBadge />}
          </div>
        </div>
      </div>
      <p className="mt-3 text-sm">
        <span className="sr-only">{t("skills")}: </span>
        {a.skills.map((s) => skillName(s, locale)).join(" · ")}
      </p>
      <p className="mt-1 text-sm text-muted">
        <span className="sr-only">{t("languages")}: </span>
        {a.languages.map((l) => languageName(l, locale)).join(", ")}
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
        <span className="font-semibold">
          {t("perMin", { price: rupeesPerMin(a.price_per_min_paise, locale) })}
        </span>
        {showPresence && <PresenceBadge presence={a.presence} wait={a.wait_minutes} />}
      </div>
    </article>
  );
}
