import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers read cookies through next/headers; give them a plain cookie jar.
const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));

import { POST as createAiConversation } from "../src/app/api/ai/conversations/route";
import { GET as getAiConversation } from "../src/app/api/ai/conversations/[id]/route";
import { POST as askAi } from "../src/app/api/ai/conversations/[id]/questions/route";
import { POST as createLead } from "../src/app/api/remedies/leads/route";
import { GET as listReports } from "../src/app/api/reports/route";
import { GET as reportFile } from "../src/app/api/reports/[id]/file/route";
import { POST as createReportOrder } from "../src/app/api/reports/orders/route";
import { GET as getReportOrder } from "../src/app/api/reports/orders/[id]/route";
import { POST as reportCheckout } from "../src/app/api/reports/orders/[id]/checkout-result/route";
import { GET as products } from "../src/app/api/reports/products/route";
import { GET as sample } from "../src/app/api/reports/sample/route";
import { apiReportPath } from "../src/lib/revenue/route";

const TOKEN = "secret-session-token-123";
const DEVICE = "0123456789abcdef0123456789abcdef";
const API = "http://localhost:8000";
const K1 = "11111111-1111-4111-8111-111111111111";
const K2 = "22222222-2222-4222-8222-222222222222";

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
let calls: Call[];
let replies: (() => Response)[];

beforeEach(() => {
  jar.clear();
  jar.set("ap_session", TOKEN);
  jar.set("ap_device", DEVICE);
  calls = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: Call["init"]) => {
      calls.push({ url, init: { ...init, headers: init?.headers ?? {} } });
      return (replies.shift() ?? (() => Response.json({ ok: true })))();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function req(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}
const params = <T>(p: T) => ({ params: Promise.resolve(p) });
const IDEM = { "idempotency-key": "intent-key-0001" };

async function leaks(res: Response): Promise<boolean> {
  const text = await res.clone().text();
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join("\n");
  return text.includes(TOKEN) || headers.includes(TOKEN);
}

describe("report orders", () => {
  const order = { sku: "kundli_report", language: "hi", kundli_ids: [K1], pay_with: "wallet" };

  it("forwards with the Bearer token, device id and the browser's Idempotency-Key", async () => {
    replies.push(() => Response.json({ id: "o1", status: "paid" }, { status: 201 }));
    const res = await createReportOrder(
      req("/api/reports/orders", {
        method: "POST",
        body: { ...order, email: "a@example.com", extra: "dropped" },
        headers: IDEM,
      }),
    );
    expect(res.status).toBe(201);
    const c = calls[0]!;
    expect(c.url).toBe(`${API}/v1/reports/orders`);
    expect(c.init.method).toBe("POST");
    expect(c.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.init.headers["x-device-id"]).toBe(DEVICE);
    expect(c.init.headers["idempotency-key"]).toBe("intent-key-0001");
    expect(JSON.parse(String(c.init.body))).toEqual({ ...order, email: "a@example.com" });
    expect(await leaks(res)).toBe(false);
  });

  it("requires an Idempotency-Key (money is never moved without one)", async () => {
    const res = await createReportOrder(
      req("/api/reports/orders", { method: "POST", body: order }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: "idempotency_key_required" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed Idempotency-Key", async () => {
    const res = await createReportOrder(
      req("/api/reports/orders", {
        method: "POST",
        body: order,
        headers: { "idempotency-key": "bad key!" },
      }),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 401 without calling the API when signed out", async () => {
    jar.delete("ap_session");
    const res = await createReportOrder(
      req("/api/reports/orders", { method: "POST", body: order, headers: IDEM }),
    );
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ ...order, kundli_ids: [K1, K2] }, "invalid_kundli_ids"],
    [{ ...order, sku: "matching_report", kundli_ids: [K1] }, "invalid_kundli_ids"],
    [{ ...order, sku: "matching_report", kundli_ids: [K1, K1] }, "invalid_kundli_ids"],
    [{ ...order, kundli_ids: ["../etc"] }, "invalid_kundli_ids"],
    [{ ...order, sku: "gold_report" }, "invalid_sku"],
    [{ ...order, language: "ta" }, "invalid_language"],
    [{ ...order, pay_with: "cash" }, "invalid_pay_with"],
    [{ ...order, email: "not-an-email" }, "invalid_email"],
  ])("validates the kundli count per sku and the other fields (%#)", async (body, code) => {
    const res = await createReportOrder(
      req("/api/reports/orders", { method: "POST", body, headers: IDEM }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code });
    expect(calls).toHaveLength(0);
  });

  it("accepts two different kundlis for a matching report", async () => {
    replies.push(() => Response.json({ id: "o2", status: "created" }, { status: 201 }));
    const res = await createReportOrder(
      req("/api/reports/orders", {
        method: "POST",
        body: { ...order, sku: "matching_report", kundli_ids: [K1, K2], pay_with: "razorpay" },
        headers: IDEM,
      }),
    );
    expect(res.status).toBe(201);
    expect(JSON.parse(String(calls[0]!.init.body)).kundli_ids).toEqual([K1, K2]);
  });

  it("flattens a 402 so the UI can read required and available amounts", async () => {
    replies.push(() =>
      Response.json(
        {
          detail: {
            code: "insufficient_funds",
            message: "x",
            required_paise: 49900,
            available_paise: 10000,
          },
        },
        { status: 402 },
      ),
    );
    const res = await createReportOrder(
      req("/api/reports/orders", { method: "POST", body: order, headers: IDEM }),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      code: "insufficient_funds",
      required_paise: 49900,
      available_paise: 10000,
    });
  });

  it("reads an order and records the checkout result", async () => {
    await getReportOrder(req("/api/reports/orders/o1"), params({ id: "o1" }));
    expect(calls[0]!.url).toBe(`${API}/v1/reports/orders/o1`);
    await reportCheckout(
      req("/api/reports/orders/o1/checkout-result", {
        method: "POST",
        body: { provider_payment_id: "pay_1", provider_signature: "sig", x: 1 },
      }),
      params({ id: "o1" }),
    );
    expect(calls[1]!.url).toBe(`${API}/v1/reports/orders/o1/checkout-result`);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      provider_payment_id: "pay_1",
      provider_signature: "sig",
    });
    const bad = await getReportOrder(req("/api/reports/orders/x"), params({ id: "a/b" }));
    expect(bad.status).toBe(404);
  });
});

describe("reports and files", () => {
  it("lists the user's reports with the session token", async () => {
    replies.push(() => Response.json({ items: [] }));
    const res = await listReports(req("/api/reports"));
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe(`${API}/v1/reports`);
    expect(calls[0]!.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("streams a ready report through a fresh signed link on our API origin only", async () => {
    replies.push(() =>
      Response.json({
        id: "r1",
        status: "ready",
        download_url: "https://evil.example/v1/reports/r1/file?sig=abc",
      }),
    );
    replies.push(
      () =>
        new Response("%PDF-1.7", {
          headers: { "content-type": "application/pdf", "set-cookie": "x=1" },
        }),
    );
    const res = await reportFile(req("/api/reports/r1/file"), params({ id: "r1" }));
    expect(calls[0]!.url).toBe(`${API}/v1/reports/r1`);
    expect(calls[1]!.url).toBe(`${API}/v1/reports/r1/file?sig=abc`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.text()).toBe("%PDF-1.7");
  });

  it("refuses a report that is not ready", async () => {
    replies.push(() => Response.json({ id: "r1", status: "rendering", download_url: null }));
    const res = await reportFile(req("/api/reports/r1/file"), params({ id: "r1" }));
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("keeps download links on the API's /v1/reports paths", () => {
    expect(apiReportPath("/v1/reports/r1/file?sig=1")).toBe("/v1/reports/r1/file?sig=1");
    expect(apiReportPath("http://x/v1/wallet")).toBeNull();
    expect(apiReportPath("/v1/reports/r2/file", "/v1/reports/r1/file")).toBeNull();
  });

  it("serves products and the sample without a session", async () => {
    jar.clear();
    replies.push(() => Response.json({ items: [{ sku: "kundli_report", price_paise: 49900 }] }));
    const p = await products();
    expect(p.status).toBe(200);
    expect(calls[0]!.init.headers).toEqual({});
    replies.push(() => Response.json({ download_url: "/v1/reports/sample/file?sig=s" }));
    replies.push(() => new Response("%PDF", { headers: { "content-type": "application/pdf" } }));
    const s = await sample(req("/api/reports/sample?sku=kundli_report&language=hi"));
    expect(calls[1]!.url).toBe(`${API}/v1/reports/sample?sku=kundli_report&language=hi`);
    expect(calls[2]!.url).toBe(`${API}/v1/reports/sample/file?sig=s`);
    expect(s.headers.get("content-type")).toBe("application/pdf");
    const bad = await sample(req("/api/reports/sample?sku=x&language=hi"));
    expect(bad.status).toBe(400);
  });
});

describe("AI assistant routes", () => {
  it("are a plain 404 while the ai_assistant flag is off", async () => {
    vi.stubEnv("FLAG_AI_ASSISTANT", "false");
    for (const res of [
      await createAiConversation(
        req("/api/ai/conversations", { method: "POST", body: { kundli_id: K1 } }),
      ),
      await getAiConversation(req("/api/ai/conversations/c1"), params({ id: "c1" })),
      await askAi(
        req("/api/ai/conversations/c1/questions", {
          method: "POST",
          body: { text: "Hi" },
          headers: IDEM,
        }),
        params({ id: "c1" }),
      ),
    ])
      expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("forward questions with the Idempotency-Key when the flag is on", async () => {
    vi.stubEnv("FLAG_AI_ASSISTANT", "true");
    replies.push(() => Response.json({ id: "q1", status: "queued" }, { status: 202 }));
    const res = await askAi(
      req("/api/ai/conversations/c1/questions", {
        method: "POST",
        body: { text: "  What is my Moon sign?  " },
        headers: IDEM,
      }),
      params({ id: "c1" }),
    );
    expect(res.status).toBe(202);
    expect(calls[0]!.url).toBe(`${API}/v1/ai/conversations/c1/questions`);
    expect(calls[0]!.init.headers["idempotency-key"]).toBe("intent-key-0001");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "What is my Moon sign?" });
  });

  it("validate the question and require an Idempotency-Key", async () => {
    vi.stubEnv("FLAG_AI_ASSISTANT", "true");
    const ask = (body: unknown, headers: Record<string, string> = IDEM) =>
      askAi(
        req("/api/ai/conversations/c1/questions", { method: "POST", body, headers }),
        params({ id: "c1" }),
      );
    expect((await ask({ text: "   " })).status).toBe(422);
    expect((await ask({ text: "x".repeat(501) })).status).toBe(422);
    expect((await ask({ text: "ok" }, {})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("remedy leads", () => {
  const lead = { remedy_id: "puja-1", language: "en", consent: true };

  it("require consent: true (never forwarded without it)", async () => {
    for (const consent of [undefined, false, "true", 1]) {
      const res = await createLead(
        req("/api/remedies/leads", { method: "POST", body: { ...lead, consent }, headers: IDEM }),
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ code: "consent_required" });
    }
    expect(calls).toHaveLength(0);
  });

  it("forward a valid lead with the Idempotency-Key and only contract fields", async () => {
    replies.push(() => Response.json({ id: "l1", status: "new" }, { status: 201 }));
    const res = await createLead(
      req("/api/remedies/leads", {
        method: "POST",
        body: { ...lead, preferred_date: "2026-11-02", note: " call after 6 ", phone: "x" },
        headers: IDEM,
      }),
    );
    expect(res.status).toBe(201);
    expect(calls[0]!.url).toBe(`${API}/v1/remedies/leads`);
    expect(calls[0]!.init.headers["idempotency-key"]).toBe("intent-key-0001");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      ...lead,
      preferred_date: "2026-11-02",
      note: "call after 6",
    });
  });

  it("reject long notes, bad dates and a missing key", async () => {
    const post = (body: unknown, headers: Record<string, string> = IDEM) =>
      createLead(req("/api/remedies/leads", { method: "POST", body, headers }));
    expect((await post({ ...lead, note: "x".repeat(501) })).status).toBe(422);
    expect((await post({ ...lead, preferred_date: "02/11/2026" })).status).toBe(422);
    expect((await post(lead, {})).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
