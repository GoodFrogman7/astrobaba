import type { Locale } from "@astro/shared";
import type { Metadata } from "next";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { ChatRoom } from "@/components/chat/ChatRoom";
import { SafetyNotice } from "@/components/trust/SafetyNotice";
import { routing } from "@/i18n/routing";
import { privateMetadata } from "@/lib/seo";

type Props = { params: Promise<{ locale: string; sessionId: string }> };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Personal page for a chat or a voice call: noindex, not in the sitemap. The session itself loads
 * in the browser (it sits behind the httpOnly session cookie).
 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "billing.session" });
  return privateMetadata(t("title"));
}

export default async function ChatPage({ params }: Props) {
  const { locale: raw, sessionId } = await params;
  if (!hasLocale(routing.locales, raw) || !ID.test(sessionId)) notFound();
  const locale: Locale = raw;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "billing.session" });
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <div className="mt-2">
        <SafetyNotice locale={locale} />
      </div>
      <div className="mt-4">
        <ChatRoom sessionId={sessionId} />
      </div>
    </main>
  );
}
