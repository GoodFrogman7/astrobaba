import { AI_LABEL, DISCLAIMER } from "@astro/shared";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import enCore from "../messages/en.json" with { type: "json" };
import enBilling from "../messages/en/billing.json" with { type: "json" };
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import enRevenue from "../messages/en/revenue.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiBilling from "../messages/hi/billing.json" with { type: "json" };
import hiMarket from "../messages/hi/marketplace.json" with { type: "json" };
import hiRevenue from "../messages/hi/revenue.json" with { type: "json" };

const MESSAGES = {
  en: { ...enCore, ...enMarket, ...enBilling, ...enRevenue },
  hi: { ...hiCore, ...hiMarket, ...hiBilling, ...hiRevenue },
};

vi.mock("server-only", () => ({}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/ai",
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator: make } = await import("next-intl");
  return {
    getTranslations: async ({ locale, namespace }: { locale: "en" | "hi"; namespace?: string }) =>
      make({ locale, messages: MESSAGES[locale], namespace: namespace as never }),
    setRequestLocale: () => undefined,
  };
});
vi.mock("@/lib/marketplace/data", () => ({
  featuredAstrologers: async () => [],
  sitemapSlugs: async () => [],
}));
const data = vi.hoisted(() => ({
  products: null as unknown,
  remedies: null as unknown,
}));
vi.mock("@/lib/revenue/data", () => ({
  loadReportProducts: async () => data.products,
  loadRemedies: async () => data.remedies,
}));
vi.mock("@/components/revenue/AiAssistant", () => ({
  AiAssistant: () => <div data-testid="ai-island" />,
}));

import AiPage, { generateMetadata as aiMeta } from "../src/app/[locale]/ai/page";
import { generateMetadata as accountMeta } from "../src/app/[locale]/account/reports/page";
import RemediesPage, { generateMetadata as remediesMeta } from "../src/app/[locale]/remedies/page";
import ReportsPage, { generateMetadata as reportsMeta } from "../src/app/[locale]/reports/page";
import sitemap from "../src/app/sitemap";
import { txnLabelKey } from "../src/components/billing/TransactionList";
import { QuestionItem } from "../src/components/revenue/AiQuestionItem";
import { LeadForm } from "../src/components/revenue/RemedyRequest";
import { ReportItems } from "../src/components/revenue/ReportsList";
import { SiteFooter } from "../src/components/SiteFooter";
import { NAV } from "../src/components/SiteHeader";
import { siteRoutes } from "../src/lib/routes";
import { PRIVATE_PATH_PREFIXES } from "../src/lib/seo";
import type { AiQuestion, Report } from "../src/lib/revenue/types";

function render(node: ReactNode, locale: "en" | "hi" = "en") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
}

/** Server components (async) render through the streaming renderer. */
async function renderAsync(node: ReactNode, locale: "en" | "hi" = "en") {
  const stream = await renderToReadableStream(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
  await stream.allReady;
  return new Response(stream).text();
}

const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

beforeEach(() => {
  data.products = null;
  data.remedies = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("AI assistant page", () => {
  it("is a 404 with no metadata while the ai_assistant flag is off", async () => {
    vi.stubEnv("FLAG_AI_ASSISTANT", "false");
    await expect(AiPage(params("en"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await aiMeta(params("en"))).toEqual({});
  });

  it("has no links to /ai anywhere while the flag is off", async () => {
    vi.stubEnv("FLAG_AI_ASSISTANT", "false");
    const footer = await renderAsync(await SiteFooter({ locale: "en" }));
    expect(footer).not.toContain('href="/ai"');
    const page = await renderAsync(await ReportsPage(params("en")));
    expect(page).not.toContain('href="/ai"');
    expect(NAV.map((n) => n.href)).not.toContain("/ai");
  });

  it("is labelled AI, says it is not a human and carries the disclaimer when on", async () => {
    vi.stubEnv("FLAG_AI_ASSISTANT", "true");
    for (const locale of ["en", "hi"] as const) {
      const html = await renderAsync(await AiPage(params(locale)), locale);
      expect(html).toContain(AI_LABEL[locale]);
      expect(html).toContain('data-testid="ai-not-human"');
      expect(html).toContain(DISCLAIMER[locale]);
      expect(html).toContain('href="/astrologers"');
      expect(html).not.toMatch(/<img\b/);
      const meta = await aiMeta(params(locale));
      expect(meta.robots).toEqual({ index: false, follow: false });
    }
    const footer = await renderAsync(await SiteFooter({ locale: "en" }));
    expect(footer).toContain('href="/ai"');
  });

  const q = (o: Partial<AiQuestion>): AiQuestion => ({
    id: "q1",
    text: "When does my Saturn period start?",
    status: "answered",
    answer: "Per your chart's dasha table, the Saturn mahadasha begins on the listed date.",
    blocked_reason: null,
    created_at: "2026-10-21T06:00:00Z",
    answered_at: "2026-10-21T06:00:05Z",
    price_paise: 1000,
    refunded: false,
    ...o,
  });

  it("labels every answer AI and offers the human hand-off", () => {
    for (const locale of ["en", "hi"] as const) {
      const html = render(<QuestionItem q={q({})} locale={locale} />, locale);
      expect(html).toContain('data-testid="ai-label"');
      expect(html).toContain(AI_LABEL[locale]);
      expect(html).toContain(MESSAGES[locale].revenue.ai.handoff);
      expect(html).toContain('href="/astrologers"');
      expect(html).toContain(MESSAGES[locale].revenue.ai.aiNote);
    }
  });

  it("explains a blocked answer in plain words, with the refund and the hand-off", () => {
    const html = render(
      <QuestionItem
        q={q({ status: "blocked", answer: null, blocked_reason: "medical", refunded: true })}
        locale="en"
      />,
    );
    expect(html).toContain(enRevenue.revenue.ai.blocked.medical);
    expect(html).toContain("₹10 refunded to your wallet.");
    expect(html).toContain(AI_LABEL.en);
    expect(html).toContain('href="/astrologers"');
    // Blocked before charging (ADR-0010): free, no recharge prompt, still the hand-off.
    const free = render(
      <QuestionItem
        q={q({ status: "blocked", answer: null, blocked_reason: "self_harm", price_paise: 0 })}
        locale="hi"
      />,
      "hi",
    );
    expect(free).toContain(hiRevenue.revenue.ai.blocked.selfHarm);
    expect(free).toContain(hiRevenue.revenue.ai.notCharged);
    expect(free).not.toContain("/wallet");
    expect(free).toContain('href="/astrologers"');
    const pending = render(<QuestionItem q={q({ status: "queued", answer: null })} locale="en" />);
    expect(pending).toContain(enRevenue.revenue.ai.thinking);
  });
});

describe("/reports page", () => {
  it("shows API prices and a Product + Offer JSON-LD", async () => {
    data.products = [
      { sku: "kundli_report", price_paise: 49900, languages: ["en", "hi"], pages_estimate: 18 },
      { sku: "matching_report", price_paise: 39900, languages: ["en", "hi"], pages_estimate: 15 },
    ];
    const html = await renderAsync(await ReportsPage(params("en")));
    expect(html).toContain("₹499");
    expect(html).toContain("₹399");
    expect(html).toContain("About 18 A4 pages");
    expect(html).toContain('"@type":"Product"');
    expect(html).toContain('"price":"499.00"');
    expect(html).toContain('"priceCurrency":"INR"');
    expect(html).toContain("/api/reports/sample?sku=kundli_report&amp;language=hi");
    expect(html).toContain("Ashtakoota table: all 8 kootas with points");
    expect(html).toContain('data-testid="buy-kundli_report"');
    expect(html).not.toMatch(/\d+ (people|users) (online|bought)/i);
  });

  it("never invents a price when the API is unavailable", async () => {
    const html = await renderAsync(await ReportsPage(params("hi")), "hi");
    expect(html).toContain(hiRevenue.revenue.reports.priceAtCheckout);
    expect(html).not.toContain('"@type":"Product"');
    expect(html).not.toMatch(/₹\s?\d/);
  });

  it("is indexable with canonical and hreflang", async () => {
    const meta = await reportsMeta(params("hi"));
    expect(meta.robots).toBeUndefined();
    expect(String(meta.alternates?.canonical)).toMatch(/\/hi\/reports$/);
    expect(Object.keys(meta.alternates?.languages ?? {})).toEqual(["en", "hi", "x-default"]);
  });
});

describe("/account/reports", () => {
  const report = (o: Partial<Report>): Report => ({
    id: "r1",
    sku: "kundli_report",
    language: "hi",
    status: "ready",
    title: "Kundli report",
    created_at: "2026-10-21T06:00:00Z",
    ready_at: "2026-10-21T06:03:00Z",
    pages: 18,
    download_url: "/v1/reports/r1/file?sig=x",
    ...o,
  });

  it("is private", async () => {
    const meta = await accountMeta(params("en"));
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates).toBeUndefined();
  });

  it("shows status, language, IST date and a download only when ready", () => {
    const html = render(
      <ReportItems
        items={[
          report({}),
          report({ id: "r2", status: "rendering", download_url: null, pages: null }),
          report({ id: "r3", status: "failed", download_url: null, pages: null }),
        ]}
      />,
    );
    expect(html).toContain('href="/api/reports/r1/file"');
    expect(html).not.toContain("/api/reports/r2/file");
    expect(html).not.toContain("/api/reports/r3/file");
    expect(html).toContain("Hindi");
    expect(html).toContain("21 Oct 2026, 11:30 am IST");
    expect(html).toContain(enRevenue.revenue.account.statusHelp.rendering);
    expect(html).toContain(enRevenue.revenue.account.statusHelp.failed);
    expect(html).toContain("18 pages");
  });

  it("has an empty state that links to the reports", () => {
    expect(render(<ReportItems items={[]} />)).toContain('href="/reports"');
  });
});

describe("/remedies", () => {
  it("is public but noindex (not in the sitemap) until reviewed", async () => {
    const meta = await remediesMeta(params("en"));
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(siteRoutes().map((r) => r.path)).not.toContain("/remedies");
  });

  it("renders only what the API lists, and says so when it is empty", async () => {
    data.remedies = [];
    expect(await renderAsync(await RemediesPage(params("en")))).toContain(
      enRevenue.revenue.remedies.empty,
    );
    data.remedies = null;
    expect(await renderAsync(await RemediesPage(params("en")))).toContain(
      enRevenue.revenue.remedies.unavailable,
    );
    data.remedies = [
      {
        id: "p1",
        kind: "puja",
        name: { en: "Partner puja A", hi: "साझेदार पूजा क" },
        description: { en: "Desc A", hi: "विवरण क" },
        price_note: { en: "Price set by the partner", hi: "कीमत साझेदार तय करेगा" },
      },
    ];
    const html = await renderAsync(await RemediesPage(params("hi")), "hi");
    expect(html).toContain("साझेदार पूजा क");
    expect(html).toContain(hiRevenue.revenue.remedies.request);
    expect(html).toContain(hiRevenue.revenue.remedies.noSale);
  });

  it("the request form's consent box is required and starts unticked", () => {
    const html = render(<LeadForm remedyId="p1" />);
    const box = /<input[^>]*data-testid="lead-consent"[^>]*>/.exec(html)?.[0] ?? "";
    expect(box).toContain('type="checkbox"');
    expect(box).toContain("required");
    expect(box).not.toMatch(/\bchecked\b/);
    expect(html).toContain(enRevenue.revenue.remedies.consent);
    expect(html).toContain(enRevenue.revenue.remedies.noSale.replace(/'/g, "&#x27;"));
    expect(html).toContain('maxLength="500"');
  });
});

describe("sitemap and navigation", () => {
  it("lists /reports in both locales and no private page", async () => {
    const urls = (await sitemap()).map((e) => new URL(e.url).pathname);
    expect(urls).toContain("/reports");
    expect(urls).toContain("/hi/reports");
    expect(urls).not.toContain("/remedies");
    for (const u of urls) {
      const path = u.replace(/^\/hi(?=\/|$)/, "");
      for (const p of PRIVATE_PATH_PREFIXES)
        expect(path === p || path.startsWith(`${p}/`), u).toBe(false);
    }
    expect(PRIVATE_PATH_PREFIXES).toEqual(expect.arrayContaining(["/account", "/ai"]));
  });

  it("header has Reports; footer has Reports and Remedies", async () => {
    expect(NAV.map((n) => n.href)).toContain("/reports");
    const footer = await renderAsync(await SiteFooter({ locale: "hi" }), "hi");
    expect(footer).toContain('href="/reports"');
    expect(footer).toContain('href="/remedies"');
    expect(footer).toContain(hiRevenue.revenue.links.remedies);
  });

  it("wallet history names purchases when the row says what was bought", () => {
    expect(txnLabelKey({ kind: "purchase", product: "report" })).toBe("kinds.purchaseReport");
    expect(txnLabelKey({ kind: "purchase", product: "ai_question" })).toBe("kinds.purchaseAi");
    expect(txnLabelKey({ kind: "purchase" })).toBe("kinds.purchase");
    expect(txnLabelKey({ kind: "refund" })).toBe("kinds.refund");
    const t = createTranslator({ locale: "en", messages: MESSAGES.en, namespace: "billing.txn" });
    expect(t("kinds.purchase")).toBe("Purchase");
    expect(t("kinds.purchaseReport")).toBe("Report");
    expect(t("kinds.purchaseAi")).toBe("AI question");
  });
});
