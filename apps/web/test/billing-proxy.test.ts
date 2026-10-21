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

import { GET as getWallet } from "../src/app/api/wallet/route";
import { GET as getTxns } from "../src/app/api/wallet/transactions/route";
import { POST as createOrder } from "../src/app/api/wallet/recharge-orders/route";
import { POST as checkoutResult } from "../src/app/api/wallet/recharge-orders/[id]/checkout-result/route";
import { POST as simulate } from "../src/app/api/dev/payments/[orderId]/simulate/route";
import { POST as createSession } from "../src/app/api/sessions/route";
import { POST as wsTicket } from "../src/app/api/sessions/[id]/ws-ticket/route";
import { GET as messages } from "../src/app/api/sessions/[id]/messages/route";
import { POST as review } from "../src/app/api/sessions/[id]/review/route";
import { clientIp } from "../src/lib/billing/forward";

const TOKEN = "secret-session-token-123";
const DEVICE = "0123456789abcdef0123456789abcdef";
const API = "http://localhost:8000";

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
let calls: Call[];
let reply: () => Response;

beforeEach(() => {
  jar.clear();
  jar.set("ap_session", TOKEN);
  jar.set("ap_device", DEVICE);
  calls = [];
  reply = () => Response.json({ ok: true }, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: Call["init"]) => {
      calls.push({ url, init });
      return reply();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

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

async function leaks(res: Response): Promise<boolean> {
  const text = await res.clone().text();
  const headers = [...res.headers.entries()].map(([k, v]) => `${k}:${v}`).join("\n");
  return text.includes(TOKEN) || headers.includes(TOKEN);
}

describe("forwarding to the API", () => {
  it("adds the Bearer token, device id and the browser's Idempotency-Key", async () => {
    reply = () => Response.json({ id: "ord_1", status: "created" }, { status: 201 });
    const res = await createOrder(
      req("/api/wallet/recharge-orders", {
        method: "POST",
        body: { amount_paise: 50000, extra: "dropped" },
        headers: { "idempotency-key": "intent-key-0001" },
      }),
    );
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe(`${API}/v1/wallet/recharge-orders`);
    expect(c.init.method).toBe("POST");
    expect(c.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(c.init.headers["x-device-id"]).toBe(DEVICE);
    expect(c.init.headers["idempotency-key"]).toBe("intent-key-0001");
    expect(JSON.parse(String(c.init.body))).toEqual({ amount_paise: 50000 });
    expect(await leaks(res)).toBe(false);
  });

  it("never relays upstream headers (no token or upstream cookies reach the browser)", async () => {
    reply = () =>
      new Response(JSON.stringify({ ticket: "t1", expires_in: 30, path: "/v1/sessions/s1/ws" }), {
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "x=1", "x-upstream": TOKEN },
      });
    const res = await wsTicket(
      req("/api/sessions/s1/ws-ticket", { method: "POST" }),
      params({ id: "s1" }),
    );
    expect(calls[0]!.url).toBe(`${API}/v1/sessions/s1/ws-ticket`);
    expect(await leaks(res)).toBe(false);
    expect(res.headers.get("x-upstream")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ ticket: "t1", expires_in: 30, path: "/v1/sessions/s1/ws" });
  });

  it("adds the API WebSocket origin from API_WS_URL at request time", async () => {
    vi.stubEnv("API_WS_URL", "wss://api.example.test/");
    reply = () => Response.json({ ticket: "t1", expires_in: 30, path: "/v1/sessions/s1/ws" });
    const res = await wsTicket(
      req("/api/sessions/s1/ws-ticket", { method: "POST" }),
      params({ id: "s1" }),
    );
    vi.unstubAllEnvs();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ticket: "t1",
      expires_in: 30,
      path: "/v1/sessions/s1/ws",
      ws_base: "wss://api.example.test",
    });
  });

  it("refuses without a session and does not call the API", async () => {
    jar.delete("ap_session");
    const res = await createSession(
      req("/api/sessions", { method: "POST", body: { astrologer_id: "a2" } }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: "not_signed_in" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a malformed Idempotency-Key instead of passing it on", async () => {
    const res = await createOrder(
      req("/api/wallet/recharge-orders", {
        method: "POST",
        body: { amount_paise: 50000 },
        headers: { "idempotency-key": "bad key!" },
      }),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("creates a device id when there is none and sets it as an httpOnly cookie", async () => {
    jar.delete("ap_device");
    const res = await createSession(
      req("/api/sessions", {
        method: "POST",
        body: { astrologer_id: "a2", free: true },
        headers: { "idempotency-key": "intent-key-0002" },
      }),
    );
    const sent = calls[0]!.init.headers["x-device-id"];
    expect(sent).toMatch(/^[a-f0-9]{32}$/);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`ap_device=${sent}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      astrologer_id: "a2",
      kind: "chat",
      free: true,
    });
  });

  it("forwards the client IP our proxy saw, not a client-supplied one", async () => {
    await createSession(
      req("/api/sessions", {
        method: "POST",
        body: { astrologer_id: "a2" },
        headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
      }),
    );
    expect(calls[0]!.init.headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(new Headers({ "x-forwarded-for": "<script>" }))).toBeUndefined();
    expect(clientIp(new Headers())).toBeUndefined();
  });

  it("flattens API errors so the UI can read the extra fields", async () => {
    reply = () =>
      Response.json(
        {
          detail: {
            code: "insufficient_funds",
            message: "Not enough balance",
            minutes_affordable: 1,
            required_paise: 2500,
          },
        },
        { status: 402 },
      );
    const res = await createSession(
      req("/api/sessions", { method: "POST", body: { astrologer_id: "a2" } }),
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({
      code: "insufficient_funds",
      message: "Not enough balance",
      minutes_affordable: 1,
      required_paise: 2500,
    });

    reply = () =>
      Response.json(
        { detail: { code: "session_open", message: "x" }, session_id: "s9" },
        { status: 409 },
      );
    const open = await createSession(
      req("/api/sessions", { method: "POST", body: { astrologer_id: "a2" } }),
    );
    expect(await open.json()).toMatchObject({ code: "session_open", session_id: "s9" });
  });

  it("answers 503 when the API is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const res = await wsTicket(
      req("/api/sessions/s1/ws-ticket", { method: "POST" }),
      params({ id: "s1" }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ code: "upstream_unavailable" });
  });
});

describe("wallet", () => {
  it("signed out is a normal answer, without calling the API", async () => {
    jar.delete("ap_session");
    const res = await getWallet(req("/api/wallet"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signed_in: false });
    expect(calls).toHaveLength(0);
  });

  it("an expired session reads as signed out; a wallet is wrapped", async () => {
    reply = () => Response.json({ detail: { code: "not_authenticated" } }, { status: 401 });
    expect(await (await getWallet(req("/api/wallet"))).json()).toEqual({ signed_in: false });
    reply = () => Response.json({ real_paise: 100, promo_paise: 0, total_paise: 100 });
    const res = await getWallet(req("/api/wallet"));
    expect(await res.json()).toEqual({
      signed_in: true,
      wallet: { real_paise: 100, promo_paise: 0, total_paise: 100 },
    });
    expect(calls.at(-1)!.url).toBe(`${API}/v1/wallet`);
  });

  it("transactions pass a safe cursor and clamp the limit", async () => {
    await getTxns(req("/api/wallet/transactions?cursor=abc_123&limit=500"));
    expect(calls[0]!.url).toBe(`${API}/v1/wallet/transactions?cursor=abc_123&limit=50`);
    await getTxns(req("/api/wallet/transactions?cursor=../../x&limit=x"));
    expect(calls[1]!.url).toBe(`${API}/v1/wallet/transactions?limit=20`);
  });

  it("validates amounts, checkout results and simulate outcomes before forwarding", async () => {
    const bad = await createOrder(
      req("/api/wallet/recharge-orders", { method: "POST", body: { amount_paise: 99.5 } }),
    );
    expect(bad.status).toBe(422);
    const cr = await checkoutResult(
      req("/api/wallet/recharge-orders/o1/checkout-result", {
        method: "POST",
        body: { provider_payment_id: "pay_1", provider_signature: "sig_1" },
      }),
      params({ id: "o1" }),
    );
    expect(cr.status).toBe(200);
    expect(calls[0]!.url).toBe(`${API}/v1/wallet/recharge-orders/o1/checkout-result`);
    const sim = await simulate(
      req("/api/dev/payments/o1/simulate", { method: "POST", body: { outcome: "refunded" } }),
      params({ orderId: "o1" }),
    );
    expect(sim.status).toBe(422);
    await simulate(
      req("/api/dev/payments/o1/simulate", { method: "POST", body: { outcome: "captured" } }),
      params({ orderId: "o1" }),
    );
    expect(calls.at(-1)!.url).toBe(`${API}/v1/dev/payments/o1/simulate`);
    expect(calls).toHaveLength(2);
  });
});

describe("sessions", () => {
  it("rejects odd ids without calling the API", async () => {
    const res = await wsTicket(
      req("/api/sessions/x/ws-ticket", { method: "POST" }),
      params({ id: "../admin" }),
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("history backfill passes after_seq and caps the limit", async () => {
    await messages(req("/api/sessions/s1/messages?after_seq=41&limit=9999"), params({ id: "s1" }));
    expect(calls[0]!.url).toBe(`${API}/v1/sessions/s1/messages?after_seq=41&limit=200`);
    await messages(req("/api/sessions/s1/messages?after_seq=-3"), params({ id: "s1" }));
    expect(calls[1]!.url).toBe(`${API}/v1/sessions/s1/messages?after_seq=0&limit=200`);
  });

  it("reviews go to the consult-sessions endpoint with a valid rating", async () => {
    const bad = await review(
      req("/api/sessions/s1/review", { method: "POST", body: { rating: 6 } }),
      params({ id: "s1" }),
    );
    expect(bad.status).toBe(422);
    await review(
      req("/api/sessions/s1/review", { method: "POST", body: { rating: 5, text: " Helpful " } }),
      params({ id: "s1" }),
    );
    expect(calls[0]!.url).toBe(`${API}/v1/consult-sessions/s1/review`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ rating: 5, text: "Helpful" });
  });
});
