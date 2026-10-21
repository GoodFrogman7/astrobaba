import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import enBilling from "../messages/en/billing.json" with { type: "json" };

vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({
  getTranslations:
    async ({ locale }: { locale: string }) =>
    (key: string) =>
      `${locale}:${key}`,
  setRequestLocale: () => undefined,
}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { generateMetadata as chatMeta } from "../src/app/[locale]/chat/[sessionId]/page";
import { generateMetadata as walletMeta } from "../src/app/[locale]/wallet/page";
import { WalletNavLink } from "../src/components/billing/WalletNavLink";
import { siteRoutes } from "../src/lib/routes";
import { PRIVATE_PATH_PREFIXES, privateMetadata } from "../src/lib/seo";

describe("private pages", () => {
  it("are noindex, nofollow in both locales", async () => {
    for (const locale of ["en", "hi"]) {
      const w = await walletMeta({ params: Promise.resolve({ locale }) });
      const c = await chatMeta({ params: Promise.resolve({ locale, sessionId: "s1" }) });
      for (const m of [w, c]) {
        expect(m.robots).toEqual({ index: false, follow: false });
        expect(m.alternates).toBeUndefined();
      }
    }
    expect(privateMetadata("Wallet").robots).toEqual({ index: false, follow: false });
  });

  it("are never in the sitemap", () => {
    const paths = siteRoutes().map((r) => r.path);
    for (const prefix of PRIVATE_PATH_PREFIXES)
      expect(paths.filter((p) => p === prefix || p.startsWith(`${prefix}/`))).toEqual([]);
  });
});

describe("header wallet link", () => {
  it("server markup is an empty, fixed-size slot (no balance, no layout shift)", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={enBilling} timeZone="Asia/Kolkata">
        <WalletNavLink />
      </NextIntlClientProvider>,
    );
    expect(html).toMatch(
      /<span class="[^"]*h-9[^"]*min-w-\[5\.5rem\][^"]*" data-testid="wallet-slot"><\/span>/,
    );
    expect(html).not.toContain("href");
  });
});
