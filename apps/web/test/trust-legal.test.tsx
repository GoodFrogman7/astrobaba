import { BRAND_NAME } from "@astro/shared";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import billing from "../../../data/marketplace/billing.json" with { type: "json" };
import policies from "../../../data/legal/policies.json" with { type: "json" };
import helplines from "../../../data/safety/helplines.json" with { type: "json" };
import enCore from "../messages/en.json" with { type: "json" };
import enRevenue from "../messages/en/revenue.json" with { type: "json" };
import enTrust from "../messages/en/trust.json" with { type: "json" };
import enGrowth from "../messages/en/growth.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiRevenue from "../messages/hi/revenue.json" with { type: "json" };
import hiTrust from "../messages/hi/trust.json" with { type: "json" };
import hiGrowth from "../messages/hi/growth.json" with { type: "json" };

const MESSAGES = {
  en: { ...enCore, ...enRevenue, ...enTrust, ...enGrowth },
  hi: { ...hiCore, ...hiRevenue, ...hiTrust, ...hiGrowth },
};

vi.mock("server-only", () => ({}));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next-intl/server", async () => {
  const { createTranslator: make } = await import("next-intl");
  return {
    getTranslations: async ({ locale, namespace }: { locale: "en" | "hi"; namespace?: string }) =>
      make({ locale, messages: MESSAGES[locale], namespace: namespace as never }),
    setRequestLocale: () => undefined,
  };
});
vi.mock("@/lib/marketplace/data", () => ({ sitemapSlugs: async () => [] }));

import AccountPage, { generateMetadata as accountMeta } from "../src/app/[locale]/account/page";
import CreditPage from "../src/app/[locale]/credit-policy/page";
import GrievancePage from "../src/app/[locale]/grievance/page";
import PrivacyPage, { generateMetadata as privacyMeta } from "../src/app/[locale]/privacy/page";
import RefundPage from "../src/app/[locale]/refund-policy/page";
import SafetyPage, { generateMetadata as safetyMeta } from "../src/app/[locale]/safety/page";
import TermsPage from "../src/app/[locale]/terms/page";
import sitemap from "../src/app/sitemap";
import { LEGAL_LINKS, SiteFooter } from "../src/components/SiteFooter";
import { normalizeLegal } from "../src/lib/trust/legal";
import { LEGAL_PAGES, LEGAL_PATHS } from "../src/lib/trust/pages";
import { creditPolicy, KNOWN_REFUND_RULES, refundRules } from "../src/lib/trust/policy";
import { BUNDLED_RESOURCES, normalizeResources } from "../src/lib/trust/resources";
import type { LegalContent } from "../src/lib/trust/content";

type Locale = "en" | "hi";
const params = (locale: string) => ({ params: Promise.resolve({ locale }) });

async function renderAsync(node: ReactNode, locale: Locale = "en") {
  const stream = await renderToReadableStream(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
  await stream.allReady;
  return new Response(stream).text();
}

const decode = (s: string) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");

/** What the API answers for /v1/legal and /v1/safety/resources (null = unreachable). */
let api: Record<string, unknown> | null = null;
beforeEach(() => {
  api = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (!api || !(path in api)) throw new Error("ECONNREFUSED");
      return Response.json(api[path]);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const PAGES = {
  terms: TermsPage,
  privacy: PrivacyPage,
  refunds: RefundPage,
  credit: CreditPage,
  grievance: GrievancePage,
  safety: SafetyPage,
} as const;

describe("policy pages", () => {
  it("show the policy version and the draft note in both languages", async () => {
    expect(policies.status).toMatch(/^draft/);
    for (const locale of ["en", "hi"] as const)
      for (const key of LEGAL_PAGES) {
        const html = await renderAsync(await PAGES[key](params(locale)), locale);
        expect(html, key).toContain(MESSAGES[locale].trust.legal.version.replace("{version}", ""));
        expect(html, key).toContain(policies.version);
        expect(html, key).toContain('data-testid="legal-draft"');
        expect(html, key).toContain(MESSAGES[locale].trust.legal.draftTitle);
        expect(html, key).toContain('"@type":"BreadcrumbList"');
        expect(html).not.toMatch(/\{(brand|minStart|grace|promoDays)\}/);
        if (locale === "hi") expect(html).toMatch(/[ऀ-ॿ]/);
      }
  });

  it("drop the draft note once a version is approved, and follow the API's version", async () => {
    api = { "/v1/legal": { ...policies, status: "approved", version: "2027-01-01" } };
    const html = await renderAsync(await TermsPage(params("en")));
    expect(html).toContain("Version 2027-01-01");
    expect(html).not.toContain('data-testid="legal-draft"');
    expect(html).not.toContain('data-testid="lawyer-todo"');
  });

  it("mark the sections the lawyer must complete while in draft", async () => {
    const html = await renderAsync(await TermsPage(params("en")));
    expect(html).toContain('data-testid="lawyer-todo"');
    expect(html).toContain(enTrust.trust.legal.lawyer);
  });

  it("are indexable with canonical and hreflang, and listed in the sitemap", async () => {
    const meta = await privacyMeta(params("hi"));
    expect(meta.robots).toBeUndefined();
    expect(String(meta.alternates?.canonical)).toMatch(/\/hi\/privacy$/);
    expect(Object.keys(meta.alternates?.languages ?? {})).toEqual(["en", "hi", "x-default"]);
    expect(String(meta.title)).toContain(BRAND_NAME);
    const urls = (await sitemap()).map((e) => new URL(e.url).pathname);
    for (const path of Object.values(LEGAL_PATHS)) {
      expect(urls).toContain(path);
      expect(urls).toContain(`/hi${path}`);
    }
    expect(urls).not.toContain("/account");
  });

  it("are linked from the footer, with /account", async () => {
    const footer = await renderAsync(await SiteFooter({ locale: "hi" }), "hi");
    for (const l of LEGAL_LINKS) expect(footer).toContain(`href="${l.href}"`);
    expect(LEGAL_LINKS.map((l) => l.href)).toEqual([
      ...LEGAL_PAGES.map((k) => LEGAL_PATHS[k]),
      "/account",
    ]);
  });

  it("have the same sections in English and Hindi, and distinct descriptions", async () => {
    const descriptions: string[] = [];
    for (const key of LEGAL_PAGES) {
      const load = async (l: Locale) =>
        (await import(`../src/content/${l}/legal/${key}.json`)).default as LegalContent;
      const [en, hi] = [await load("en"), await load("hi")];
      expect(hi.sections.map((s) => [s.id, s.slot ?? null, !!s.lawyer])).toEqual(
        en.sections.map((s) => [s.id, s.slot ?? null, !!s.lawyer]),
      );
      for (const c of [en, hi]) {
        const d = c.description.replace("{brand}", BRAND_NAME);
        expect(d.length, `${key} description`).toBeGreaterThanOrEqual(50);
        expect(d.length, `${key} description`).toBeLessThanOrEqual(160);
        descriptions.push(d);
      }
    }
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });
});

describe("/privacy", () => {
  it("lists the processors from the registry and shows unpublished fields honestly", async () => {
    const html = await renderAsync(await PrivacyPage(params("en")));
    const ids = [...html.matchAll(/data-processor="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(policies.processors.map((p) => p.id));
    for (const p of policies.processors) expect(decode(html)).toContain(p.purpose);
    // Operator name/address and grievance officer are null in the registry.
    const pending = html.match(/data-testid="to-be-published"/g) ?? [];
    expect(pending.length).toBeGreaterThanOrEqual(4);
    expect(html).toContain(enTrust.trust.legal.toBePublished);
    expect(html).toContain(enTrust.trust.privacy.providerPending);
    expect(html).toContain('data-testid="retention"');
  });

  it("renders what GET /v1/legal returns, its placeholders localized", async () => {
    api = {
      "/v1/legal": {
        ...policies,
        operator: { legal_name: "Example Astro Pvt Ltd", address: "to be published" },
        grievance_officer: { name: "A. Officer", email: "grievance@example.in" },
        processors: [{ id: "razorpay", purpose: "Payments", data: "Ids", region: "India" }],
      },
    };
    const html = await renderAsync(await PrivacyPage(params("hi")), "hi");
    expect(html).toContain("Example Astro Pvt Ltd");
    expect(html).toContain('href="mailto:grievance@example.in"');
    expect(html).toContain(hiTrust.trust.legal.toBePublished);
    expect(html).not.toContain("to be published");
    expect([...html.matchAll(/data-processor="([^"]+)"/g)].map((m) => m[1])).toEqual(["razorpay"]);
    expect(html).toContain(hiTrust.trust.privacy.regionIndia);
    expect(normalizeLegal({ version: 1 })).toBeNull();
  });
});

describe("/privacy analytics section (docs/api/growth.md §1.1)", () => {
  it("explains the analytics, quotes the configured periods and shows the switch", async () => {
    for (const locale of ["en", "hi"] as const) {
      const html = decode(await renderAsync(await PrivacyPage(params(locale)), locale));
      expect(html).toContain('id="analytics"');
      expect(html).toContain('data-testid="analytics-switch"');
      expect(html).toContain('role="switch"');
      expect(html).toContain(MESSAGES[locale].growth.analytics.label);
      expect(html).toContain("180");
      expect(html).toContain("400");
      expect(html).toContain("Global Privacy Control");
      expect(html).not.toMatch(/\{(aidDays|retentionDays)\}/);
    }
  });
});

describe("/refund-policy", () => {
  it("states exactly the enabled refund rules from billing.json with their numbers", async () => {
    const html = decode(await renderAsync(await RefundPage(params("en"))));
    const enabled = Object.entries(billing.refund_rules)
      .filter(([, r]) => typeof r === "object" && (r as { enabled: boolean }).enabled)
      .map(([id]) => id);
    expect([...html.matchAll(/data-rule="([^"]+)"/g)].map((m) => m[1])).toEqual(enabled);
    expect(html).toContain(`${billing.refund_rules.low_rating.refund_bps / 100}%`);
    expect(html).toContain("₹200");
    expect(html).toContain(`within ${billing.refund_rules.low_rating.window_hours} hours`);
    expect(html).toContain(`${billing.sessions.join_timeout_s} seconds`);
    expect(html).toContain(`${billing.recharge_bonus_tiers.promo_expiry_days} days later`);
  });

  it("drops a rule that is switched off, and every configured rule has copy", () => {
    const off = structuredClone(billing);
    off.refund_rules.low_rating.enabled = false;
    expect(refundRules(off).map((r) => r.id)).not.toContain("low_rating");
    for (const id of Object.keys(billing.refund_rules).filter((k) => k !== "decided")) {
      expect(KNOWN_REFUND_RULES).toContain(id);
      expect(enTrust.trust.refunds.rules).toHaveProperty(id);
      expect(hiTrust.trust.refunds.rules).toHaveProperty(id);
    }
  });
});

describe("/credit-policy", () => {
  it("promo first, promo expiry days, real-credit expiry to be set before launch", async () => {
    const html = decode(await renderAsync(await CreditPage(params("en"))));
    expect(html).toContain(enTrust.trust.credit.spendOrderValue);
    expect(html).toContain(`${billing.recharge_bonus_tiers.promo_expiry_days} days after`);
    expect(html).toContain("Period to be set before launch");
    expect(creditPolicy(billing, {}).promoFirst).toBe(true);
    expect(html).toContain(enTrust.trust.credit.bonusOff);
  });

  it("shows bonus tiers and the free consultation only while their flags are on", async () => {
    const on = creditPolicy(billing, {
      FLAG_RECHARGE_BONUS_TIERS: "true",
      FLAG_FIRST_FREE_SESSION: "true",
    });
    expect(on.bonus).toEqual({
      enabled: true,
      tiers: [
        { minPaise: 50000, percent: 5 },
        { minPaise: 100000, percent: 10 },
        { minPaise: 200000, percent: 15 },
      ],
    });
    expect(on.freeSession).toEqual({ enabled: true, minutes: billing.free_session.minutes });
    vi.stubEnv("FLAG_RECHARGE_BONUS_TIERS", "true");
    const html = decode(await renderAsync(await CreditPage(params("en"))));
    expect(html).toContain("5% extra from ₹500");
  });
});

describe("/grievance", () => {
  it("shows the grievance officer fields as to be published while they are null", async () => {
    const html = await renderAsync(await GrievancePage(params("en")));
    expect(html).toContain('data-testid="operator"');
    expect(html).toContain(enTrust.trust.legal.toBePublished);
  });
});

describe("/safety", () => {
  const numbersIn = (html: string) => ({
    tel: [...html.matchAll(/href="tel:([^"]+)"/g)].map((m) => m[1]),
    shown: [...html.matchAll(/data-testid="helpline-call">([^<]+)</g)].map((m) => m[1]),
  });

  it("shows exactly the numbers in helplines.json, tap-to-call, with the not-a-helpline text", async () => {
    const file = helplines.helplines.map((h) => h.number);
    for (const locale of ["en", "hi"] as const) {
      const html = await renderAsync(await SafetyPage(params(locale)), locale);
      const { tel, shown } = numbersIn(html);
      expect(tel).toEqual(file);
      expect(shown.map((s) => (s ?? "").replace(/\D/g, ""))).toEqual(file);
      expect(decode(html)).toContain(helplines.not_a_helpline[locale]);
      for (const h of helplines.helplines) expect(decode(html)).toContain(h.name[locale]);
      // No other phone-like number anywhere in the page body.
      const main = /<main[\s\S]*<\/main>/.exec(html)?.[0] ?? "";
      const text = main.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ");
      const digits = [...text.matchAll(/\b\d{3,}\b/g)].map((m) => m[0]);
      expect(digits.filter((d) => !file.includes(d) && !/^20\d\d$/.test(d))).toEqual([]);
    }
  });

  it("uses GET /v1/safety/resources when it answers (still only valid numbers)", async () => {
    api = {
      "/v1/safety/resources": {
        ...helplines,
        helplines: [helplines.helplines[0], { ...helplines.helplines[1], number: "call-me" }],
      },
    };
    const html = await renderAsync(await SafetyPage(params("en")));
    expect(numbersIn(html).tel).toEqual([helplines.helplines[0]!.number]);
    expect(normalizeResources({ helplines: [], not_a_helpline: helplines.not_a_helpline })).toBe(
      null,
    );
    expect(BUNDLED_RESOURCES.helplines.map((h) => h.number)).toEqual(
      helplines.helplines.map((h) => h.number),
    );
  });

  it("is indexable", async () => {
    expect((await safetyMeta(params("en"))).robots).toBeUndefined();
  });
});

describe("/account", () => {
  it("is private (noindex, nofollow) and renders a static shell", async () => {
    const meta = await accountMeta(params("en"));
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates).toBeUndefined();
    const html = await renderAsync(await AccountPage(params("en")));
    expect(html).toContain(enTrust.trust.account.title);
    expect(html).toContain(enTrust.trust.account.loading);
  });
});
