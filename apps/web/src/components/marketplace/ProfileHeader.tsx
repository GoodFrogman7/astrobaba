import { useLocale, useTranslations } from "next-intl";
import { monthYear, rupeesPerMin } from "@/lib/marketplace/format";
import { languageName, skillName, tierName } from "@/lib/marketplace/taxonomy";
import type { AstrologerProfile } from "@/lib/marketplace/types";
import { Avatar } from "./Avatar";
import { DemoBadge } from "./DemoBadge";
import { PresenceBadge } from "./Presence";
import { RatingText } from "./RatingText";

export function ProfileHeader({ p }: { p: AstrologerProfile }) {
  const t = useTranslations("market.profile");
  const tc = useTranslations("market.card");
  const locale = useLocale() as "en" | "hi";
  const verified = (["identity", "qualification", "interview"] as const).filter(
    (k) => p.verified[k],
  );
  return (
    <section aria-label={p.display_name} className="rounded-md border border-border bg-surface p-5">
      {p.is_demo && (
        <p
          className="mb-3 rounded-sm border border-accent px-3 py-2 text-sm text-accent"
          data-testid="demo-notice"
        >
          {t("demoNotice")}
        </p>
      )}
      <div className="flex items-start gap-4">
        <Avatar name={p.display_name} size="lg" />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <PresenceBadge presence={p.presence} wait={p.wait_minutes} />
            {p.is_demo && <DemoBadge />}
          </div>
          <p className="mt-1">
            <RatingText rating={p.rating} />
          </p>
          <p className="mt-1 text-sm text-muted">
            {t("since", { date: monthYear(p.on_platform_since, locale) })}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">{t("skills")}</dt>
          <dd>{p.skills.map((s) => skillName(s, locale)).join(", ")}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("languages")}</dt>
          <dd>{p.languages.map((l) => languageName(l, locale)).join(", ")}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("experience")}</dt>
          <dd>{tc("experience", { years: p.experience_years })}</dd>
        </div>
        <div>
          <dt className="text-muted">{t("price")}</dt>
          <dd>
            {tc("perMin", { price: rupeesPerMin(p.price_per_min_paise, locale) })} · {t("tier")}:{" "}
            {tierName(p.tier, locale)}
          </dd>
        </div>
      </dl>
      {verified.length > 0 && (
        <div className="mt-4">
          <h2 className="text-sm font-medium">{t("verified")}</h2>
          <ul className="mt-1 flex flex-wrap gap-2 text-sm" data-testid="verified">
            {verified.map((k) => (
              <li key={k} className="rounded-full border border-border px-3 py-1">
                <span aria-hidden="true">✓ </span>
                {t(k)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Bio is user-written text: rendered as plain text, never HTML. */
export function ProfileBio({ p }: { p: AstrologerProfile }) {
  const t = useTranslations("market.profile");
  const locale = useLocale();
  const useHindi = locale === "hi" && !!p.bio_hi;
  return (
    <section aria-labelledby="about">
      <h2 id="about" className="text-xl font-semibold">
        {t("about")}
      </h2>
      {locale === "hi" && !useHindi && (
        <p className="mt-2 text-sm text-muted">{t("bioInEnglish")}</p>
      )}
      <p className="mt-3 whitespace-pre-line leading-relaxed" lang={useHindi ? "hi" : "en"}>
        {useHindi ? p.bio_hi : p.bio}
      </p>
    </section>
  );
}
