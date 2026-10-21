import { requireLocale } from "@/lib/almanac/locale";
import { setRequestLocale } from "next-intl/server";
import { PanchangPage, panchangMetadata } from "@/components/almanac/PanchangPage";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; city: string; date: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale: rawLocale, city, date } = await params;
  const locale = requireLocale(rawLocale);
  return panchangMetadata(locale, city, "date", date);
}

export default async function Page({ params }: Props) {
  const { locale: rawLocale, city, date } = await params;
  const locale = requireLocale(rawLocale);
  setRequestLocale(locale);
  return <PanchangPage locale={locale} slug={city} mode="date" dateParam={date} />;
}
