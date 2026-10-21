import { describe, expect, it } from "vitest";
import productsFile from "../../../data/marketplace/products.json" with { type: "json" };
import { IntentKeys } from "../src/lib/billing/idempotency";
import { askQuestion, blockedKey, validateQuestion } from "../src/lib/revenue/ai";
import { placeOrder, stateFor, validateOrder, type OrderInput } from "../src/lib/revenue/buy";
import { AI_QUESTION, KUNDLIS_PER_SKU } from "../src/lib/revenue/config";
import { leadBody, validateLead } from "../src/lib/revenue/remedies";
import { downloadHref, needsPolling, watchReports } from "../src/lib/revenue/reports";
import type { Report } from "../src/lib/revenue/types";

type Post = Parameters<typeof placeOrder>[2];

/** A fake `call` that answers in order and records what was sent. */
function poster(...answers: ({ status: number; body: Record<string, unknown> } | "network")[]) {
  const sent: { url: string; init: Record<string, unknown> }[] = [];
  const post = (async (url: string, init: Record<string, unknown>) => {
    sent.push({ url, init });
    const a = answers.shift()!;
    if (a === "network") return { ok: false, status: 0, error: { code: "network_error" } };
    return a.status >= 200 && a.status < 300
      ? { ok: true, status: a.status, data: a.body }
      : { ok: false, status: a.status, error: { code: "unexpected_error", ...a.body } };
  }) as unknown as Post;
  return { post, sent };
}

const K1 = "k-one";
const K2 = "k-two";
const base: OrderInput = {
  sku: "kundli_report",
  language: "en",
  kundliIds: [K1],
  payWith: "wallet",
  email: "",
};
const order = (o: Record<string, unknown> = {}) => ({
  id: "o1",
  sku: "kundli_report",
  language: "en",
  status: "paid",
  price_paise: 49900,
  pay_with: "wallet",
  provider_order_id: null,
  key_id: null,
  report_id: "r1",
  created_at: "2026-10-21T06:00:00Z",
  paid_at: "2026-10-21T06:00:00Z",
  ...o,
});
const ctx = (keys = new IntentKeys(() => "key-report-0001")) => ({
  price: 49900,
  balance: 60000,
  keys,
});

describe("kundli count per report (from data/marketplace/products.json)", () => {
  it("matches the settings file: 1 for kundli, 2 for matching", () => {
    expect(KUNDLIS_PER_SKU).toEqual({
      kundli_report: productsFile.reports.kundli_report.kundlis,
      matching_report: productsFile.reports.matching_report.kundlis,
    });
    expect(KUNDLIS_PER_SKU).toEqual({ kundli_report: 1, matching_report: 2 });
  });

  it("rejects the wrong count or the same kundli twice, before any request", async () => {
    expect(validateOrder({ ...base, kundliIds: [] })).toEqual(["kundliCount"]);
    expect(validateOrder({ ...base, kundliIds: [K1, K2] })).toEqual(["kundliCount"]);
    expect(validateOrder({ ...base, sku: "matching_report" })).toEqual(["kundliCount"]);
    expect(validateOrder({ ...base, sku: "matching_report", kundliIds: [K1, K1] })).toEqual([
      "kundliDistinct",
    ]);
    expect(validateOrder({ ...base, sku: "matching_report", kundliIds: [K1, K2] })).toEqual([]);
    expect(validateOrder({ ...base, email: "nope" })).toEqual(["email"]);
    expect(validateOrder({ ...base, language: "hi" }, ["en"])).toEqual(["language"]);

    const { post, sent } = poster();
    const r = await placeOrder({ ...base, sku: "matching_report" }, ctx(), post);
    expect(r).toEqual({ kind: "invalid", errors: ["kundliCount"] });
    expect(sent).toHaveLength(0);
  });
});

describe("buying a report", () => {
  it("wallet: one POST with an Idempotency-Key, paid at once", async () => {
    const { post, sent } = poster({ status: 201, body: order() });
    const r = await placeOrder({ ...base, email: " me@example.com " }, ctx(), post);
    expect(r.kind).toBe("paid");
    expect(sent).toEqual([
      {
        url: "/api/reports/orders",
        init: {
          method: "POST",
          body: {
            sku: "kundli_report",
            language: "en",
            kundli_ids: [K1],
            pay_with: "wallet",
            email: "me@example.com",
          },
          idempotencyKey: "key-report-0001",
        },
      },
    ]);
    expect(stateFor(r).step).toBe("paid");
  });

  it("razorpay: the created order goes on to Checkout", async () => {
    const { post } = poster({
      status: 201,
      body: order({ status: "created", pay_with: "razorpay", provider_order_id: "order_x" }),
    });
    const r = await placeOrder({ ...base, payWith: "razorpay" }, ctx(), post);
    expect(r.kind).toBe("checkout");
    expect(stateFor(r).step).toBe("checkout");
  });

  it("402: says what is missing and links to /wallet with the shortfall", async () => {
    const { post } = poster({
      status: 402,
      body: { code: "insufficient_funds", required_paise: 49900, available_paise: 12345 },
    });
    const r = await placeOrder(base, { ...ctx(), balance: 12345 }, post);
    // 49900 - 12345 = 37555 → rounded up to whole rupees (37600), at least the minimum recharge.
    expect(r).toEqual({
      kind: "insufficient",
      required: 49900,
      available: 12345,
      suggest: Math.max(37600, 0),
    });
    expect(stateFor(r)).toMatchObject({ step: "insufficient", suggest: 37600 });
  });

  it("a network error keeps the key, so pressing Pay again cannot buy twice", async () => {
    const keys = new IntentKeys(
      (() => {
        let n = 0;
        return () => `key-report-000${++n}`;
      })(),
    );
    const { post, sent } = poster("network", { status: 201, body: order() });
    expect((await placeOrder(base, ctx(keys), post)).kind).toBe("message");
    expect((await placeOrder(base, ctx(keys), post)).kind).toBe("paid");
    expect(sent.map((s) => s.init.idempotencyKey)).toEqual(["key-report-0001", "key-report-0001"]);
    // A new intent after an answer gets a new key.
    const again = poster({ status: 201, body: order() });
    await placeOrder({ ...base, language: "hi" }, ctx(keys), again.post);
    expect(again.sent[0]!.init.idempotencyKey).toBe("key-report-0002");
  });

  it("401 asks to sign in; a reused key with other details is explained", async () => {
    expect((await placeOrder(base, ctx(), poster({ status: 401, body: {} }).post)).kind).toBe(
      "signin",
    );
    const r = await placeOrder(
      base,
      ctx(),
      poster({ status: 409, body: { code: "idempotency_conflict" } }).post,
    );
    expect(r).toEqual({ kind: "message", key: "conflict" });
  });
});

const report = (status: Report["status"], o: Partial<Report> = {}): Report => ({
  id: "r1",
  sku: "kundli_report",
  language: "en",
  status,
  title: "Kundli report",
  created_at: "2026-10-21T06:00:00Z",
  ready_at: null,
  pages: null,
  download_url: null,
  ...o,
});

describe("reports list polling", () => {
  it("polls while queued or rendering and stops when ready", async () => {
    const answers = [
      [report("queued")],
      [report("rendering")],
      [report("ready", { download_url: "/v1/reports/r1/file?sig=x", pages: 18 })],
    ];
    const seen: string[] = [];
    const sleeps: number[] = [];
    const r = await watchReports(
      async () => ({ ok: true, items: answers.shift()! }),
      (items) => seen.push(items[0]!.status),
      { sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(r).toBe("settled");
    expect(seen).toEqual(["queued", "rendering", "ready"]);
    expect(sleeps).toEqual([3000, 4000]);
  });

  it("does not poll when everything is ready or failed", async () => {
    let reads = 0;
    const r = await watchReports(
      async () => {
        reads++;
        return { ok: true, items: [report("ready"), report("failed", { id: "r2" })] };
      },
      () => undefined,
    );
    expect(r).toBe("settled");
    expect(reads).toBe(1);
    expect(needsPolling([report("failed")])).toBe(false);
  });

  it("gives up after the time limit and reports read errors (401 = signed out)", async () => {
    const stalled = await watchReports(
      async () => ({ ok: true, items: [report("queued")] }),
      () => undefined,
      { sleep: async () => undefined, maxMs: 10_000 },
    );
    expect(stalled).toBe("stalled");
    expect(
      await watchReports(
        async () => ({ ok: false, status: 401 }),
        () => undefined,
      ),
    ).toEqual({ error: 401 });
  });

  it("offers a download only for a ready report with a link", () => {
    expect(downloadHref(report("ready", { download_url: "/x" }))).toBe("/api/reports/r1/file");
    expect(downloadHref(report("ready"))).toBeNull();
    expect(downloadHref(report("failed", { download_url: "/x" }))).toBeNull();
  });
});

describe("AI questions", () => {
  it("uses the price and limit from data/marketplace/products.json", () => {
    expect(AI_QUESTION).toEqual({
      pricePaise: productsFile.ai_question.price_paise,
      maxChars: productsFile.ai_question.max_chars,
    });
    expect(validateQuestion("  ")).toBe("empty");
    expect(validateQuestion("a".repeat(AI_QUESTION.maxChars))).toBeNull();
    expect(validateQuestion("a".repeat(AI_QUESTION.maxChars + 1))).toBe("tooLong");
  });

  it("asks with an Idempotency-Key and explains a 402", async () => {
    type AskPost = Parameters<typeof askQuestion>[3];
    const sent: unknown[] = [];
    const post = (async (url: string, init: unknown) => {
      sent.push({ url, init });
      return {
        ok: false,
        status: 402,
        error: { code: "insufficient_funds", required_paise: 1000, available_paise: 0 },
      };
    }) as unknown as AskPost;
    const r = await askQuestion(
      "c1",
      " When does my dasha change? ",
      { keys: new IntentKeys(() => "key-ai-000001"), balance: 0 },
      post,
    );
    expect(sent).toEqual([
      {
        url: "/api/ai/conversations/c1/questions",
        init: {
          method: "POST",
          body: { text: "When does my dasha change?" },
          idempotencyKey: "key-ai-000001",
        },
      },
    ]);
    expect(r).toMatchObject({ kind: "insufficient", required: 1000, available: 0 });
  });

  it("explains blocked answers in plain words", () => {
    expect(blockedKey("self_harm")).toBe("selfHarm");
    expect(blockedKey("medical")).toBe("medical");
    expect(blockedKey("legal_advice")).toBe("legal");
    expect(blockedKey("financial")).toBe("financial");
    expect(blockedKey("grounding_failed")).toBe("unsafe");
    expect(blockedKey(null)).toBe("unsafe");
  });
});

describe("remedy leads", () => {
  const lead = {
    remedyId: "puja-1",
    preferredDate: "",
    language: "en" as const,
    note: "",
    consent: false,
  };

  it("require consent, a short note and a date from today on", () => {
    expect(validateLead(lead, "2026-10-21")).toEqual(["consent"]);
    expect(validateLead({ ...lead, consent: true }, "2026-10-21")).toEqual([]);
    expect(validateLead({ ...lead, consent: true, note: "x".repeat(501) }, "2026-10-21")).toEqual([
      "note",
    ]);
    expect(
      validateLead({ ...lead, consent: true, preferredDate: "2026-10-20" }, "2026-10-21"),
    ).toEqual(["date"]);
    expect(
      validateLead({ ...lead, consent: true, preferredDate: "2026-02-30" }, "2026-10-21"),
    ).toEqual(["date"]);
  });

  it("send only the contract's fields", () => {
    expect(
      leadBody({ ...lead, consent: true, note: "  hi  ", preferredDate: "2026-11-01" }),
    ).toEqual({
      remedy_id: "puja-1",
      language: "en",
      consent: true,
      note: "hi",
      preferred_date: "2026-11-01",
    });
    expect(leadBody({ ...lead, consent: true })).toEqual({
      remedy_id: "puja-1",
      language: "en",
      consent: true,
    });
  });
});
