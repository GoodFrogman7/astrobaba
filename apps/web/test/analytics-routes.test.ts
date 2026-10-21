import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));

import { POST as collect } from "../src/app/api/e/route";
import { DELETE as optIn, POST as optOut } from "../src/app/api/e/opt-out/route";
import { POST as verify } from "../src/app/api/auth/otp/verify/route";
import { isBot, newAnonymousId } from "../src/lib/analytics/server";

const API = "http://localhost:8000";
const CHROME =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const AID = "AAECAwQFBgcICQoLDA0ODw"; // 16 bytes, base64url

type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
let calls: Call[];
let reply: (url: string) => Response | Promise<Response>;

beforeEach(() => {
  jar.clear();
  calls = [];
  reply = () => Response.json({ accepted: 1, rejected: 0 }, { status: 202 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: Call["init"]) => {
      calls.push({ url, init });
      return reply(url);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const event = (over: Record<string, unknown> = {}) => ({
  event: "page_view",
  ts: "2026-10-21T10:00:00.000Z",
  locale: "en",
  properties: { path: "/kundli" },
  ...over,
});

function req(
  body: unknown,
  { headers = {}, cookies = {}, url = "http://localhost:3000/api/e" } = {} as {
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    url?: string;
  },
) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "user-agent": CHROME,
      "content-type": "text/plain;charset=UTF-8",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieNamed = (res: Response, name: string) =>
  setCookies(res).find((c) => c.startsWith(`${name}=`));

describe("POST /api/e", () => {
  it("creates the aid cookie, fills the envelope and forwards to the API", async () => {
    const res = await collect(
      req({ events: [event(), event({ event: "tool_started", properties: { tool: "kundli" } })] }),
    );
    expect(res.status).toBe(202);
    const aid = cookieNamed(res, "aid")!;
    expect(aid).toMatch(/^aid=[A-Za-z0-9_-]{22};/);
    expect(aid).toMatch(/HttpOnly/i);
    expect(aid).toMatch(/SameSite=lax/i);
    expect(aid).toMatch(/Max-Age=15552000/);
    expect(aid).not.toMatch(/Secure/i);
    const id = aid.slice(4, 26);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/analytics/events`);
    const sent = JSON.parse(String(calls[0]!.init.body)) as { events: Record<string, unknown>[] };
    expect(sent.events).toEqual([
      {
        ...event(),
        anonymous_id: id,
        user_id: null,
        schema_version: 2,
      },
      expect.objectContaining({ event: "tool_started", anonymous_id: id, user_id: null }),
    ]);
    // The user agent is never forwarded; no token without a session.
    const h = calls[0]!.init.headers;
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("user-agent");
    expect(h.authorization).toBeUndefined();
  });

  it("keeps an existing aid, and sets Secure on https", async () => {
    const res = await collect(req({ events: [event()] }, { cookies: { aid: AID } }));
    expect(res.status).toBe(202);
    expect(cookieNamed(res, "aid")).toBeUndefined();
    const sent = JSON.parse(String(calls[0]!.init.body)) as { events: { anonymous_id: string }[] };
    expect(sent.events[0]!.anonymous_id).toBe(AID);

    const https = await collect(
      req({ events: [event()] }, { headers: { "x-forwarded-proto": "https" } }),
    );
    expect(cookieNamed(https, "aid")).toMatch(/Secure/i);
  });

  it("forwards the signed-in user's bearer token and the client IP", async () => {
    await collect(
      req(
        { events: [event()] },
        {
          cookies: { aid: AID, ap_session: "session-token-1" },
          headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" },
        },
      ),
    );
    expect(calls[0]!.init.headers.authorization).toBe("Bearer session-token-1");
    expect(calls[0]!.init.headers["x-forwarded-for"]).toBe("203.0.113.9");
  });

  it("drops invalid events in the web route too (bad locale, free text, unknown events)", async () => {
    const res = await collect(
      req({
        events: [
          event({ locale: "fr" }),
          event({ properties: { path: "/kundli", name: "Asha" } }),
          event({ event: "made_up" }),
          event({ anonymous_id: "spoofed-id-123", user_id: "someone-else" }),
        ],
      }),
    );
    expect(res.status).toBe(202);
    const sent = JSON.parse(String(calls[0]!.init.body)) as { events: Record<string, unknown>[] };
    expect(sent.events).toHaveLength(1);
    expect(sent.events[0]!.anonymous_id).not.toBe("spoofed-id-123");
    expect(sent.events[0]!.user_id).toBeNull();
  });

  it("answers 204 without a cookie when nothing in the batch is valid", async () => {
    const res = await collect(req({ events: [event({ event: "nope" })] }));
    expect(res.status).toBe(204);
    expect(setCookies(res)).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed bodies and batches over 20", async () => {
    expect((await collect(req("not json"))).status).toBe(400);
    expect((await collect(req({ nope: 1 }))).status).toBe(400);
    expect((await collect(req({ events: Array.from({ length: 21 }, () => event()) }))).status).toBe(
      400,
    );
    expect((await collect(req("x".repeat(20_000)))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  for (const [name, opts] of [
    ["Sec-GPC", { headers: { "sec-gpc": "1" } }],
    ["DNT", { headers: { dnt: "1" } }],
    ["the aid_off cookie", { cookies: { aid_off: "1" } }],
  ] as const) {
    it(`honours ${name}: 204, nothing forwarded, aid cleared`, async () => {
      const res = await collect(
        req(
          { events: [event()] },
          { ...opts, cookies: { aid: AID, ...("cookies" in opts ? opts.cookies : {}) } },
        ),
      );
      expect(res.status).toBe(204);
      expect(calls).toHaveLength(0);
      expect(cookieNamed(res, "aid")).toMatch(/^aid=;.*Max-Age=0/i);
    });
  }

  it("drops bots and requests without a user agent", async () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Mozilla/5.0 (compatible; bingbot/2.0)",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 11; moto g power) Chrome-Lighthouse",
      "facebookexternalhit/1.1",
      "curl/8.5.0",
      "python-requests/2.32",
      "",
    ]) {
      const res = await collect(req({ events: [event()] }, { headers: { "user-agent": ua } }));
      expect(res.status, ua).toBe(204);
    }
    expect(calls).toHaveLength(0);
    expect(isBot(CHROME)).toBe(false);
    expect(
      isBot("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Safari"),
    ).toBe(false);
  });

  it("ignores requests from other sites", async () => {
    const res = await collect(
      req({ events: [event()] }, { headers: { "sec-fetch-site": "cross-site" } }),
    );
    expect(res.status).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("still answers 202 when the API is down", async () => {
    reply = () => {
      throw new Error("ECONNREFUSED");
    };
    const res = await collect(req({ events: [event()] }));
    expect(res.status).toBe(202);
  });

  it("makes random 16-byte ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newAnonymousId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(Buffer.from(id, "base64url")).toHaveLength(16);
  });
});

describe("/api/e/opt-out", () => {
  const optReq = (method: string, proto = "http") =>
    new NextRequest("http://localhost:3000/api/e/opt-out", {
      method,
      headers: { cookie: `aid=${AID}`, "x-forwarded-proto": proto },
    });

  it("POST sets aid_off for a year (readable by the page) and clears aid", async () => {
    const res = await optOut(optReq("POST"));
    expect(res.status).toBe(204);
    const off = cookieNamed(res, "aid_off")!;
    expect(off).toMatch(/^aid_off=1;/);
    expect(off).toMatch(/Max-Age=31536000/);
    expect(off).not.toMatch(/HttpOnly/i);
    expect(cookieNamed(res, "aid")).toMatch(/^aid=;.*Max-Age=0/i);
    expect(cookieNamed(await optOut(optReq("POST", "https")), "aid_off")).toMatch(/Secure/i);
  });

  it("DELETE removes aid_off", async () => {
    const res = await optIn(optReq("DELETE"));
    expect(res.status).toBe(204);
    expect(cookieNamed(res, "aid_off")).toMatch(/^aid_off=;.*Max-Age=0/i);
  });
});

describe("otp_verified after sign-in", () => {
  const verifyReq = (cookies: Record<string, string>, headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost:3000/api/auth/otp/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join("; "),
        referer: "http://localhost:3000/hi/wallet",
        "x-forwarded-for": "203.0.113.9",
        ...headers,
      },
      body: JSON.stringify({ challenge_id: "ch_1", code: "123456" }),
    });

  beforeEach(() => {
    reply = (url) =>
      url.endsWith("/v1/auth/otp/verify")
        ? Response.json({
            token: "new-token-1",
            expires_at: "2099-01-01T00:00:00Z",
            user: { id: "u1", is_new: true },
          })
        : Response.json({ accepted: 1, rejected: 0 }, { status: 202 });
  });

  it("posts otp_verified with the new token and the aid", async () => {
    const res = await verify(verifyReq({ aid: AID }));
    expect(res.status).toBe(200);
    const analytics = calls.find((c) => c.url === `${API}/v1/analytics/events`)!;
    expect(analytics.init.headers.authorization).toBe("Bearer new-token-1");
    expect(analytics.init.headers["x-forwarded-for"]).toBe("203.0.113.9");
    const sent = JSON.parse(String(analytics.init.body)) as { events: Record<string, unknown>[] };
    expect(sent.events).toEqual([
      expect.objectContaining({
        event: "otp_verified",
        anonymous_id: AID,
        user_id: null,
        locale: "hi",
        schema_version: 2,
        properties: { is_new_user: true },
      }),
    ]);
  });

  it("is skipped without an aid, or with an opt-out", async () => {
    await verify(verifyReq({}));
    await verify(verifyReq({ aid: AID, aid_off: "1" }));
    await verify(verifyReq({ aid: AID }, { "sec-gpc": "1" }));
    expect(calls.filter((c) => c.url.endsWith("/v1/analytics/events"))).toHaveLength(0);
  });

  it("never breaks sign-in when analytics fails", async () => {
    reply = (url) => {
      if (url.endsWith("/v1/analytics/events")) throw new Error("ECONNREFUSED");
      return Response.json({
        token: "new-token-1",
        expires_at: "2099-01-01T00:00:00Z",
        user: { id: "u1", is_new: false },
      });
    };
    const res = await verify(verifyReq({ aid: AID }));
    expect(res.status).toBe(200);
    expect(cookieNamed(res, "ap_session")).toMatch(/^ap_session=new-token-1/);
  });
});
