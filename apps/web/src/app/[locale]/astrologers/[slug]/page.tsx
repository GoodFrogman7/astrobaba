import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { cache } from "react";
import { JsonLd } from "@/components/JsonLd";
import { ConsultCard, MobileConsultBar } from "@/components/marketplace/ConsultCard";
import { ProfileBio, ProfileHeader } from "@/components/marketplace/ProfileHeader";
import { ReviewList } from "@/components/marketplace/ReviewList";
import { PageShell } from "@/components/PageShell";
import { routing } from "@/i18n/routing";
import { fillContent, getContent } from "@/lib/content";
import { getProfile, getReviews } from "@/lib/marketplace/data";
import { parseCursor, type Query } from "@/lib/marketplace/filters";
import { personLd } from "@/lib/marketplace/jsonld";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; slug: string }>; searchParams: Promise<Query> };

const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const profile = cache((slug: string) => getProfile(slug));

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  if (!hasLocale(routing.locales, locale) || !SLUG.test(slug)) return {};
  const p = await profile(slug);
  if (!p.ok) return {};
  const content = fillContent(await getContent(locale, "astrologer-profile"), {
    name: p.data.display_name,
  });
  const paged = parseCursor(await searchParams, "reviews") !== null;
  return pageMetadata(locale, `/astrologers/${slug}`, content, {
    index: !p.data.is_demo && !paged,
  });
}

export default async function ProfilePage({ params, searchParams }: Props) {
  const { locale: raw, slug } = await params;
  if (!hasLocale(routing.locales, raw) || !SLUG.test(slug)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const p = await profile(slug);
  if (!p.ok) {
    if (p.status === 404) notFound();
    throw new Error(`profile unavailable (${p.status})`);
  }
  const a = p.data;
  const reviewsCursor = parseCursor(await searchParams, "reviews");
  const [base, paged] = await Promise.all([
    getContent(locale, "astrologer-profile"),
    getReviews(slug, reviewsCursor),
  ]);
  // A stale or tampered cursor falls back to the first page instead of hiding reviews.
  const reviews = paged.ok || !reviewsCursor ? paged : await getReviews(slug, null);
  const content = fillContent(base, { name: a.display_name });
  const astrologers = await getContent(locale, "astrologers");

  return (
    <>
      <JsonLd data={personLd(a, locale)} />
      <PageShell
        locale={locale}
        crumbs={[
          { name: astrologers.h1, path: "/astrologers" },
          { name: a.display_name, path: `/astrologers/${slug}` },
        ]}
        content={content}
        cta={false}
      >
        <div className="grid gap-6 pb-20 lg:grid-cols-[1fr_20rem] lg:pb-0">
          <div className="space-y-8">
            <ProfileHeader p={a} />
            <ProfileBio p={a} />
            {reviews.ok ? (
              <ReviewList
                slug={slug}
                name={a.display_name}
                reviews={reviews.data.items}
                rating={reviews.data.rating}
                nextCursor={reviews.data.next_cursor}
              />
            ) : null}
          </div>
          <div className="hidden lg:block">
            <ConsultCard p={a} />
          </div>
        </div>
        <MobileConsultBar p={a} />
      </PageShell>
    </>
  );
}
