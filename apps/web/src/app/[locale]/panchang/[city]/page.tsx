import { requireLocale } from "@/lib/almanac/locale";
import { setRequestLocale } from "next-intl/server";
import { PanchangPage, panchangMetadata } from "@/components/almanac/PanchangPage";

// "Today" depends on the IST date at request time; never cache the page itself.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; city: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale: rawLocale, city } = await params;
  const locale = requireLocale(rawLocale);
  return panchangMetadata(locale, city, "today");
}

export default async function Page({ params }: Props) {
  const { locale: rawLocale, city } = await params;
  const locale = requireLocale(rawLocale);
  setRequestLocale(locale);
  return <PanchangPage locale={locale} slug={city} mode="today" />;
}
