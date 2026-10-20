import { BRAND_NAME, formatInZone, IST, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { localeUrl } from "@/site";

// Server-rendered per request so the IST date is never a stale cached value.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: Locale }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return {
    title: `${t("title")} | ${BRAND_NAME}`,
    description: t("description"),
    alternates: {
      canonical: localeUrl(locale),
      languages: { en: localeUrl("en"), hi: localeUrl("hi"), "x-default": localeUrl("en") },
    },
  };
}

const TOOLS = ["kundli", "matching", "panchang"] as const;
const PRINCIPLES = ["computed", "labelled", "honest"] as const;

export default async function HomePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "home" });
  const today = formatInZone(new Date(), IST, locale === "hi" ? "hi-IN" : "en-IN", {
    dateStyle: "full",
  });

  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-12">
      <p className="text-sm font-medium text-accent">{t("eyebrow", { date: today })}</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
        {t("heading")}
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted">{t("lede")}</p>

      <section aria-labelledby="tools" className="mt-12">
        <h2 id="tools" className="text-xl font-semibold">
          {t("toolsHeading")}
        </h2>
        <ul className="mt-4 grid gap-4 sm:grid-cols-3">
          {TOOLS.map((tool) => (
            <li key={tool} className="rounded-md border border-border bg-surface p-5">
              <h3 className="font-semibold text-primary">{t(`tools.${tool}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{t(`tools.${tool}.body`)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="principles" className="mt-12">
        <h2 id="principles" className="text-xl font-semibold">
          {t("principlesHeading")}
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-muted">
          {PRINCIPLES.map((p) => (
            <li key={p}>{t(`principles.${p}`)}</li>
          ))}
        </ul>
      </section>

      <p className="mt-12 rounded-md bg-primary px-5 py-4 text-primary-fg">{t("status")}</p>
    </main>
  );
}
