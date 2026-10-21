import { requireLocale } from "@/lib/almanac/locale";
import { setRequestLocale } from "next-intl/server";
import { PanchangPage, panchangMetadata } from "@/components/almanac/PanchangPage";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; city: string }> };

export async function generateMetadata({ params }: Props) {
  const { locale: rawLocale, city } = await params;
  const locale = requireLocale(rawLocale);
  return panchangMetadata(locale, city, "tomorrow");
}

export default async function Page({ params }: Props) {
  const { locale: rawLocale, city } = await params;
  const locale = requireLocale(rawLocale);
  setRequestLocale(locale);
  return <PanchangPage locale={locale} slug={city} mode="tomorrow" />;
}
