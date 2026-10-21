import type { Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import type { Article } from "@/lib/learn";

/** "12 March 2027" from a YYYY-MM-DD calendar date, in the page's language. */
export function formatArticleDate(date: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "hi" ? "hi-IN" : "en-IN", {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

/** Author, reviewer and dates: who stands behind an article, and how fresh it is. */
export async function ArticleMeta({ a, locale }: { a: Article; locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "growth.learn" });
  return (
    <p
      className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted"
      data-testid="article-meta"
    >
      <span>{t("byline", { author: a.author })}</span>
      <span>{t("reviewedBy", { reviewer: a.reviewed_by })}</span>
      <time dateTime={a.published_at}>
        {t("published", { date: formatArticleDate(a.published_at, locale) })}
      </time>
      {a.updated_at !== a.published_at && (
        <time dateTime={a.updated_at}>
          {t("updated", { date: formatArticleDate(a.updated_at, locale) })}
        </time>
      )}
    </p>
  );
}
