import type { Locale } from "@astro/shared";
import { hasLocale } from "next-intl";
import { notFound } from "next/navigation";
import { routing } from "@/i18n/routing";

/**
 * Pages and generateMetadata run alongside the layout, so they must reject unknown locales
 * themselves (e.g. /favicon.ico matches the [locale] segment).
 */
export function requireLocale(value: string): Locale {
  if (!hasLocale(routing.locales, value)) notFound();
  return value;
}
