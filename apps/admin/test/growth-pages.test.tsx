import type {
  AlmanacDate,
  AstrologerInvite,
  ContentItem,
  GrowthFunnel,
  LaunchReadiness,
  SupplyReadiness,
} from "@astro/shared";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Next server modules stubbed and the network mocked, so guard → API client → page runs for
// real. The Phase 8 API is built in parallel; these responses follow docs/api/growth.md.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ap_admin_session" ? { value: "admin-token" } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));

const { default: GrowthPage } = await import("../src/app/growth/page");
const { default: SupplyPage } = await import("../src/app/supply/page");
const { default: ContentPage } = await import("../src/app/content/page");
const { default: LaunchPage } = await import("../src/app/launch/page");
const { default: Dashboard } = await import("../src/app/page");

type Route = (url: URL) => Response | undefined;
let routes: Route[] = [];
let roles = ["admin"];
let urls: string[] = [];

const err = (status: number, code: string, message: string) =>
  Response.json({ detail: { code, message } }, { status });

function on(path: string, res: () => Response): Route {
  return (u) => (u.pathname === path ? res() : undefined);
}

beforeEach(() => {
  routes = [];
  roles = ["admin"];
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const u = new URL(input);
      urls.push(u.pathname + u.search);
      if (u.pathname === "/v1/me") return Response.json({ id: "a1", phone: "+91•••", roles });
      for (const r of routes) {
        const res = r(u);
        if (res) return res;
      }
      return err(404, "not_found", "Not found");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const sp = <T,>(v: T) => ({ searchParams: Promise.resolve(v) });
const html = async (el: Promise<ReactElement>) => renderToStaticMarkup(await el);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

/* ---------- fixtures ---------- */

const funnel: GrowthFunnel = {
  from: "2026-09-23",
  to: "2026-10-20",
  window_days: 30,
  generated_at: "2026-10-21T05:00:00Z",
  visitor: {
    steps: [
      { key: "visit", count: 1000, reached: 1000, rate: null, target: null },
      { key: "tool_use", count: 400, reached: 420, rate: 0.4, target: null },
      { key: "otp", count: 20, reached: 31, rate: 0.05, target: { low: 0.08, high: 0.12 } },
      { key: "free_session", count: 10, reached: 10, rate: 0.5, target: { low: 0.4, high: null } },
      { key: "first_recharge", count: 0, reached: 1, rate: 0, target: { low: 0.1, high: 0.15 } },
      { key: "repeat", count: 0, reached: 0, rate: null, target: null },
    ],
    weeks: [{ week_start: "2026-09-21", counts: { visit: 300, tool_use: 100, otp: 6 } }],
    by_source: [{ key: "search", visit: 700, otp: 15, first_recharge: 0 }],
    by_tool: [],
    by_landing: [{ key: "other", visit: 12, otp: 0, first_recharge: 0 }],
  },
  account: {
    steps: [
      { key: "otp", count: 40, reached: 40, rate: null, target: null },
      { key: "free_session", count: 20, reached: 20, rate: 0.5, target: { low: 0.4, high: null } },
      { key: "first_recharge", count: 4, reached: 4, rate: 0.2, target: { low: 0.1, high: 0.15 } },
      { key: "repeat", count: 1, reached: 1, rate: 0.25, target: null },
    ],
    weeks: [],
  },
  notes: ["Visitors who opted out or block cookies are not in the visitor funnel"],
};

const emptyFunnel: GrowthFunnel = {
  ...funnel,
  visitor: {
    ...funnel.visitor,
    steps: funnel.visitor.steps.map((s) => ({ ...s, count: 0, reached: 0, rate: null })),
  },
  account: {
    steps: funnel.account.steps.map((s) => ({ ...s, count: 0, reached: 0, rate: null })),
    weeks: [],
  },
};

const hours = Array.from({ length: 7 }, (_, d) =>
  Array.from({ length: 24 }, (_, h) => (d === 0 && h === 10 ? 0 : h >= 9 && h < 23 ? 2 : 0)),
);

const supply: SupplyReadiness = {
  target: { min: 30, max: 50 },
  live: 12,
  pipeline: {
    applied: 9,
    kyc_submitted: 4,
    interview: 3,
    probation: 2,
    approved: 12,
    suspended: 1,
    rejected: 5,
  },
  steps_passed: { identity: 20, qualification: 18, interview: 14, probation: 12 },
  languages: [
    { id: "hi", live: 10, target_min: 15 },
    { id: "en", live: 15, target_min: 15 },
  ],
  skills: [{ id: "vedic", live: 7, target_min: 0 }],
  schedule: { hours, uncovered_hours: 1 },
  invites: { open: 2, used: 1, expired: 0, revoked: 0 },
};

const invites: AstrologerInvite[] = [
  {
    id: "inv1",
    note: "Varanasi referral",
    status: "open",
    created_at: "2026-10-20T06:00:00Z",
    expires_at: "2026-11-03T06:00:00Z",
    used_at: null,
    astrologer_id: null,
  },
  {
    id: "inv2",
    note: null,
    status: "used",
    created_at: "2026-10-01T06:00:00Z",
    expires_at: "2026-10-15T06:00:00Z",
    used_at: "2026-10-05T06:00:00Z",
    astrologer_id: "ast-9",
  },
];

const item = (over: Partial<ContentItem>): ContentItem => ({
  id: "c1",
  title: "Kundli basics",
  kind: "article",
  locale: "both",
  status: "drafting",
  due_date: "2026-10-22",
  url: null,
  notes: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  ...over,
});

const almanac: AlmanacDate[] = [
  { date: "2026-10-26", kind: "purnima" },
  { date: "2026-11-02", kind: "ekadashi" },
  { date: "2026-11-09", kind: "amavasya" },
  { date: "2026-11-16", kind: "sun_sign_change", sign: "scorpio" },
];

/* ---------- /growth ---------- */

describe("/growth", () => {
  it("renders both funnels with rates, targets, text classification and breakdowns", async () => {
    routes = [on("/v1/admin/growth/funnel", () => Response.json(funnel))];
    const h = await html(GrowthPage(sp({ locale: "hi", source: "search", window_days: "14" })));
    const t = text(h);
    expect(urls.find((u) => u.startsWith("/v1/admin/growth/funnel"))).toMatch(
      /window_days=14&locale=hi&source=search$/,
    );
    expect(t).toContain("Visitor funnel");
    expect(t).toContain("Account funnel");
    // tool_use → otp is 5% against 8%–12%: below, said in words.
    expect(t).toMatch(/Verified OTP 20 31 5% 8%–12% ▼ Below target/);
    expect(t).toMatch(/Started free session 10 10 50% ≥ 40% ● Within target/);
    expect(t).toMatch(/First recharge 0 1 0% 10%–15% ▼ Below target/);
    // Account: 20% against 10%–15% is above.
    expect(t).toMatch(/First recharge 4 4 20% 10%–15% ▲ Above target/);
    // A null rate shows "—", and a step with no target is not classified.
    expect(t).toMatch(/Repeat recharge 0 0 — — —/);
    // Bars are proportional to the first step.
    expect(h).toContain('style="width:40%"');
    expect(t).toContain("Other (merged)");
    expect(t).toContain("No rows.");
    expect(t).toContain("No weekly cohorts.");
    expect(t).toContain("Visitors who opted out or block cookies");
    expect(h).toContain('value="hi" selected=""');
  });

  it("shows an empty state when the cohort is 0", async () => {
    routes = [on("/v1/admin/growth/funnel", () => Response.json(emptyFunnel))];
    const t = text(await html(GrowthPage(sp({}))));
    expect(t).toContain("No visitors had their first page view in this range");
    expect(t).toContain("No accounts were created in this range.");
    expect(t).not.toContain("Below target");
  });

  it("shows a plain error and explains invalid filters", async () => {
    routes = [on("/v1/admin/growth/funnel", () => err(500, "internal", "Something failed."))];
    const t = text(await html(GrowthPage(sp({ from: "2026-13-01", window_days: "500" }))));
    expect(t).toContain("Could not load this list: Something failed.");
    expect(t).toContain("Dates must be real days");
    expect(t).toContain("The window must be a whole number of days from 1 to 90");
  });

  it("loads nothing for a non-admin", async () => {
    roles = ["client"];
    const t = text(await html(GrowthPage(sp({}))));
    expect(t).toContain("Not authorised");
    expect(urls.some((u) => u.includes("/growth/"))).toBe(false);
  });
});

/* ---------- /supply ---------- */

describe("/supply", () => {
  it("renders readiness, coverage, the schedule and invites", async () => {
    routes = [
      on("/v1/admin/growth/supply", () => Response.json(supply)),
      on("/v1/admin/astrologer-invites", () => Response.json({ items: invites })),
    ];
    const h = await html(SupplyPage(sp({})));
    const t = text(h);
    expect(t).toMatch(/12 live · target 30–50/);
    expect(t).toContain("Below minimum (18 short)");
    expect(h).toContain('href="/astrologers?status=kyc_submitted"');
    expect(t).toMatch(/Hindi 10 15 Short by 5/);
    expect(t).toMatch(/English 15 15 Meets minimum/);
    // 0-target skill.
    expect(t).toMatch(/Vedic astrology 7 0 No minimum set/);
    // Schedule: Monday first, uncovered core hour marked in text, count from the API.
    expect(t).toContain("1 core hour with nobody scheduled");
    expect(t.indexOf("Mon")).toBeLessThan(t.indexOf("Sun "));
    expect((h.match(/\(uncovered core hour\)/g) ?? []).length).toBe(1);
    // Invites: revoke only for open ones, link to the astrologer who used one.
    expect((t.match(/\bRevoke\b/g) ?? []).length).toBe(1);
    expect(h).toContain('href="/astrologers/ast-9"');
    expect(t).toContain("Varanasi referral");
    expect(t).toContain("2 open · 1 used · 0 expired · 0 revoked");
  });

  it("filters invites by status and handles an empty list and a zero target", async () => {
    routes = [
      on("/v1/admin/growth/supply", () =>
        Response.json({
          ...supply,
          target: { min: 0, max: 0 },
          live: 0,
          languages: [],
          skills: [],
        }),
      ),
      on("/v1/admin/astrologer-invites", () => Response.json({ items: [] })),
    ];
    const t = text(await html(SupplyPage(sp({ invites: "revoked" }))));
    expect(urls).toContain("/v1/admin/astrologer-invites?status=revoked");
    expect(t).toContain("No revoked invites.");
    expect(t).toContain("Within target range");
    expect(t).toContain("No minimums set in targets.json.");
  });

  it("keeps the invite tools when supply fails, and rejects a malformed schedule", async () => {
    routes = [
      on("/v1/admin/growth/supply", () => err(503, "api_unavailable", "The API is unreachable.")),
      on("/v1/admin/astrologer-invites", () => Response.json({ items: invites })),
    ];
    let t = text(await html(SupplyPage(sp({}))));
    expect(t).toContain("Could not load this list: The API is unreachable.");
    expect(t).toContain("Create invite");

    routes = [
      on("/v1/admin/growth/supply", () =>
        Response.json({ ...supply, schedule: { hours: [[1, 2]], uncovered_hours: 0 } }),
      ),
      on("/v1/admin/astrologer-invites", () => err(500, "internal", "Boom.")),
    ];
    t = text(await html(SupplyPage(sp({}))));
    expect(t).toContain("did not return 7 days of 24 hours");
    expect(t).toContain("Could not load this list: Boom.");
  });
});

/* ---------- /content ---------- */

describe("/content", () => {
  it("groups items by week and lists dates to plan around with honest labels", async () => {
    routes = [
      on("/v1/admin/content-items", () =>
        Response.json({
          items: [
            item({ id: "c1", due_date: "2026-10-22" }),
            item({
              id: "c2",
              title: "Diwali reel",
              kind: "video",
              status: "published",
              due_date: "2026-11-03",
              url: "https://example.com/reel",
            }),
          ],
        }),
      ),
      on("/v1/admin/growth/almanac-dates", () => Response.json({ items: almanac })),
    ];
    const h = await html(ContentPage(sp({})));
    const t = text(h);
    expect(urls.some((u) => u === "/v1/admin/growth/almanac-dates?days=60")).toBe(true);
    expect(urls.find((u) => u.startsWith("/v1/admin/content-items"))).toMatch(
      /^\/v1\/admin\/content-items\?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/,
    );
    expect(t).toContain("Week of Mon, 19 Oct");
    expect(t).toContain("Week of Mon, 2 Nov");
    expect(t).toContain("Purnima (tithi at sunrise, New Delhi)");
    expect(t).toContain("Ekadashi (tithi at sunrise, New Delhi)");
    expect(t).toContain("Amavasya (tithi at sunrise, New Delhi)");
    expect(t).toContain("Sun enters Scorpio (sidereal)");
    expect(t).toContain("These are not festival observance dates");
    expect(h).toContain("new_date=2026-10-26");
    expect(h).toContain('rel="noopener noreferrer"');
  });

  it("prefills the create form from a date and passes filters to the API", async () => {
    routes = [
      on("/v1/admin/content-items", () => Response.json({ items: [] })),
      on("/v1/admin/growth/almanac-dates", () => Response.json({ items: [] })),
    ];
    const h = await html(
      ContentPage(
        sp({
          from: "2026-11-02",
          to: "2026-11-15",
          status: "review",
          kind: "social",
          new_date: "2026-11-05",
          new_title: "Purnima: 2026-11-05",
        }),
      ),
    );
    expect(urls).toContain(
      "/v1/admin/content-items?from=2026-11-02&to=2026-11-15&status=review&kind=social",
    );
    expect(h).toContain('value="2026-11-05"');
    expect(h).toContain('value="Purnima: 2026-11-05"');
    expect(text(h)).toContain("Nothing planned in this range.");
    expect(text(h)).toContain("No dates in the next 60 days.");
  });

  it("says 'Engine unavailable' on 503 without failing the page", async () => {
    routes = [
      on("/v1/admin/content-items", () => Response.json({ items: [item({})] })),
      on("/v1/admin/growth/almanac-dates", () =>
        err(503, "engine_unavailable", "The engine is unreachable."),
      ),
    ];
    const t = text(await html(ContentPage(sp({}))));
    expect(t).toContain("Engine unavailable");
    expect(t).toContain("Kundli basics");
  });

  it("shows plain errors for both lists", async () => {
    routes = [
      on("/v1/admin/content-items", () => err(500, "internal", "Items failed.")),
      on("/v1/admin/growth/almanac-dates", () => err(500, "internal", "Dates failed.")),
    ];
    const t = text(await html(ContentPage(sp({}))));
    expect(t).toContain("Could not load this list: Items failed.");
    expect(t).toContain("Could not load dates: Dates failed.");
    expect(t).toContain("Add to calendar");
  });
});

/* ---------- /launch and the dashboard ---------- */

const readiness: LaunchReadiness = {
  generated_at: "2026-10-21T05:00:00Z",
  checks: [
    { id: "legal_approved", status: "pass", detail: "Version 3 approved." },
    { id: "sms_live", status: "warn", detail: "Console provider." },
    { id: "payments_live", status: "fail", detail: "Provider is fake." },
    { id: "supply_live", status: "fail", detail: "12 of 30 live." },
  ],
};

describe("/launch", () => {
  it("orders fail, warn, pass with text, icons and human labels", async () => {
    routes = [on("/v1/admin/launch-readiness", () => Response.json(readiness))];
    const t = text(await html(LaunchPage()));
    expect(t).toContain("2 failing · 1 warning · 1 passing");
    const order = [
      "Enough live astrologers",
      "Live payments (Razorpay)",
      "Live SMS provider",
      "Legal policies approved",
    ].map((l) => t.indexOf(l));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(t).toMatch(/✕ Fail Enough live astrologers 12 of 30 live\./);
    expect(t).toMatch(/! Warn Live SMS provider/);
    expect(t).toMatch(/✓ Pass Legal policies approved/);
  });

  it("handles an error and an empty list", async () => {
    routes = [on("/v1/admin/launch-readiness", () => err(500, "internal", "Down."))];
    expect(text(await html(LaunchPage()))).toContain("Could not load this list: Down.");
    routes = [
      on("/v1/admin/launch-readiness", () => Response.json({ generated_at: "x", checks: [] })),
    ];
    expect(text(await html(LaunchPage()))).toContain("The API returned no checks.");
  });
});

describe("dashboard", () => {
  it("shows the count of failing launch checks", async () => {
    routes = [on("/v1/admin/launch-readiness", () => Response.json(readiness))];
    const h = await html(Dashboard());
    expect(text(h)).toMatch(/2 Launch readiness: checks failing/);
    expect(h).toContain('href="/launch"');
  });

  it("shows “–” when readiness cannot be loaded", async () => {
    const t = text(await html(Dashboard()));
    expect(t).toMatch(/– Launch readiness: checks failing/);
  });
});
