import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

/** Core messages plus one file per area, so areas never edit the same file. */
const MESSAGE_AREAS = [
  "tools",
  "almanac",
  "marketplace",
  "billing",
  "report",
  "revenue",
  "trust",
  "growth",
] as const;

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const core = (await import(`../../messages/${locale}.json`)).default;
  const areas = await Promise.all(
    MESSAGE_AREAS.map(async (a) => (await import(`../../messages/${locale}/${a}.json`)).default),
  );
  return { locale, messages: Object.assign({}, core, ...areas) };
});
