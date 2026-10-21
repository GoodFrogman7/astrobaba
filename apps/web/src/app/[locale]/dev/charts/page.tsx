import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { NorthIndianChart, SouthIndianChart } from "@/components/charts";
import { SAMPLE_KNOWN_TIME, SAMPLE_UNKNOWN_TIME } from "@/components/charts/sample";

// Developer preview of the chart components with engine-generated samples.
// Hidden in production unless ENABLE_DEV_PAGES=true; never indexed.
export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

const SAMPLES = [
  { key: "known", heading: "2000-01-01 12:00, New Delhi", data: SAMPLE_KNOWN_TIME },
  { key: "unknown", heading: "1995-04-14, time unknown, Jaipur", data: SAMPLE_UNKNOWN_TIME },
];

export default async function ChartsPreview({ params }: { params: Promise<{ locale: Locale }> }) {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEV_PAGES !== "true") notFound();
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Chart components (dev preview)</h1>
      {SAMPLES.map((s) => (
        <section key={s.key} className="mt-10" aria-label={s.heading}>
          <h2 className="text-lg font-semibold">{s.heading}</h2>
          <div className="mt-4 grid gap-6 sm:grid-cols-2">
            <NorthIndianChart data={s.data} locale={locale} />
            <SouthIndianChart data={s.data} locale={locale} />
          </div>
        </section>
      ))}
    </main>
  );
}
