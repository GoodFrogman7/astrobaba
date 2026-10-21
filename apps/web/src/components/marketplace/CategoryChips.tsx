import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import type { Filters } from "@/lib/marketplace/filters";
import { TAXONOMY } from "@/lib/marketplace/taxonomy";

/** Speciality shortcuts: each chip shows astrologers with that one speciality. */
export function CategoryChips({ filters }: { filters: Filters }) {
  const t = useTranslations("market.directory");
  const locale = useLocale() as "en" | "hi";
  const active = filters.skills.length === 1 ? filters.skills[0] : null;
  const chip = (on: boolean) =>
    `inline-block rounded-full border px-3 py-1.5 text-sm ${on ? "border-primary bg-primary text-primary-fg" : "border-border hover:bg-surface"}`;
  return (
    <nav aria-label={t("categories")}>
      <ul className="flex flex-wrap gap-2">
        <li>
          <Link
            href="/astrologers"
            className={chip(filters.skills.length === 0)}
            aria-current={filters.skills.length === 0 ? "page" : undefined}
          >
            {t("all")}
          </Link>
        </li>
        {TAXONOMY.skills.map((s) => (
          <li key={s.id}>
            <Link
              href={{ pathname: "/astrologers", query: { skill: s.id } }}
              className={chip(active === s.id)}
              aria-current={active === s.id ? "page" : undefined}
            >
              {s[locale]}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
