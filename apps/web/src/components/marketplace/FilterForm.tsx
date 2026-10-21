import { useLocale, useTranslations } from "next-intl";
import { type Filters, hasFilters, SORTS } from "@/lib/marketplace/filters";
import { TAXONOMY } from "@/lib/marketplace/taxonomy";

const input = "mt-1 w-full rounded-sm border border-border bg-surface px-3 py-2";

/**
 * Directory filters as a plain GET form: works without JavaScript and keeps every result URL
 * shareable. The server reads the query and asks the API (server-side filtering).
 */
export function FilterForm({ filters }: { filters: Filters }) {
  const t = useTranslations("market.directory");
  const ts = useTranslations("market.sort");
  const locale = useLocale() as "en" | "hi";
  const action = locale === "en" ? "/astrologers" : `/${locale}/astrologers`;
  return (
    <details open={hasFilters(filters)} className="rounded-md border border-border bg-surface p-4">
      <summary className="cursor-pointer font-medium">{t("filters")}</summary>
      <form method="get" action={action} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <fieldset>
          <legend className="text-sm font-medium">{t("skill")}</legend>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {TAXONOMY.skills.map((s) => (
              <label key={s.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  name="skill"
                  value={s.id}
                  defaultChecked={filters.skills.includes(s.id)}
                />
                {s[locale]}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium">{t("language")}</legend>
          <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
            {TAXONOMY.languages.map((l) => (
              <label key={l.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  name="language"
                  value={l.id}
                  defaultChecked={filters.languages.includes(l.id)}
                />
                {l[locale]}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="space-y-3">
          <label className="block text-sm font-medium">
            {t("gender")}
            <select name="gender" defaultValue={filters.gender ?? ""} className={input}>
              <option value="">{t("any")}</option>
              {TAXONOMY.genders.map((g) => (
                <option key={g.id} value={g.id}>
                  {g[locale]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            {t("tier")}
            <select name="tier" defaultValue={filters.tier ?? ""} className={input}>
              <option value="">{t("any")}</option>
              {TAXONOMY.tiers.map((g) => (
                <option key={g.id} value={g.id}>
                  {g[locale]}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              {t("minPrice")}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                name="min_price"
                defaultValue={filters.minRupees ?? ""}
                className={input}
              />
            </label>
            <label className="block text-sm font-medium">
              {t("maxPrice")}
              <input
                type="number"
                inputMode="numeric"
                min={0}
                name="max_price"
                defaultValue={filters.maxRupees ?? ""}
                className={input}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 py-1 text-sm font-medium">
            <input type="checkbox" name="online" value="1" defaultChecked={filters.online} />
            {t("online")}
          </label>
          <label className="block text-sm font-medium">
            {t("sort")}
            <select name="sort" defaultValue={filters.sort} className={input}>
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {ts(s)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2 lg:col-span-3">
          <button
            type="submit"
            className="rounded-sm bg-primary px-4 py-2 font-medium text-primary-fg"
          >
            {t("apply")}
          </button>
          <a href={action} className="inline-block py-2 text-sm underline">
            {t("clear")}
          </a>
        </div>
      </form>
    </details>
  );
}
