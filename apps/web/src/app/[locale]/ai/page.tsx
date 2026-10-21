import { DISCLAIMER, flagEnabled, type Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AiAssistant } from "@/components/revenue/AiAssistant";
import { AiLabel } from "@/components/revenue/AiLabel";
import { Link } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { formatPaise } from "@/lib/marketplace/format";
import { AI_QUESTION } from "@/lib/revenue/config";
import { privateMetadata } from "@/lib/seo";

// The `ai_assistant` flag is read per request: off → this page is a plain 404.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale) || !flagEnabled("ai_assistant")) return {};
  const t = await getTranslations({ locale, namespace: "revenue.ai" });
  return privateMetadata(t("title"));
}

/** AI assistant (docs/api/revenue.md §3): private, noindex, labelled AI everywhere. */
export default async function AiPage({ params }: Props) {
  const { locale: raw } = await params;
  if (!hasLocale(routing.locales, raw) || !flagEnabled("ai_assistant")) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "revenue.ai" });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <AiLabel locale={locale} />
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="mt-4 space-y-2 rounded-md border border-border bg-surface p-4 text-sm">
        <p className="font-medium" data-testid="ai-not-human">
          {t("notHuman")}
        </p>
        <p>{t("grounded")}</p>
        <p>{t("pricing", { amount: formatPaise(AI_QUESTION.pricePaise, locale) })}</p>
        <p>
          {t("preferHuman")}{" "}
          <Link href="/astrologers" className="text-accent underline">
            {t("handoff")}
          </Link>
        </p>
        <p className="text-muted" data-testid="ai-disclaimer">
          {DISCLAIMER[locale]}
        </p>
      </div>
      <div className="mt-6">
        <Suspense fallback={<p className="text-muted">{t("loading")}</p>}>
          <AiAssistant />
        </Suspense>
      </div>
    </main>
  );
}
