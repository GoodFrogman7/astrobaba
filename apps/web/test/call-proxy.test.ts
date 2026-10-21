import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}));

import { POST as callToken } from "../src/app/api/sessions/[id]/call-token/route";
import { POST as createSession } from "../src/app/api/sessions/route";

const TOKEN = "secret-session-token-123";
const API = "http://localhost:8000";
type Call = { url: string; init: RequestInit & { headers: Record<string, string> } };
let calls: Call[];
let reply: () => Response;

beforeEach(() => {
  jar.clear();
  jar.set("ap_session", TOKEN);
  jar.set("ap_device", "0123456789abcdef0123456789abcdef");
  calls = [];
  reply = () => Response.json({}, { status: 200 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: Call["init"]) => {
      calls.push({ url, init });
      return reply();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("call token route", () => {
  it("forwards to /v1/sessions/{id}/call-token with the Bearer token and returns only CallToken", async () => {
    reply = () =>
      Response.json(
        {
          url: "wss://lk.example.test",
          token: "lk-jwt",
          room: "session-s1",
          identity: "user",
          expires_in: 600,
          api_secret: "must-not-pass",
        },
        { status: 200, headers: { "x-upstream": "nope" } },
      );
    const res = await callToken(post("/api/sessions/s1/call-token"), params("s1"));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${API}/v1/sessions/s1/call-token`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(await res.json()).toEqual({
      url: "wss://lk.example.test",
      token: "lk-jwt",
      room: "session-s1",
      identity: "user",
      expires_in: 600,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-upstream")).toBeNull();
    const text = [...res.headers.values()].join("\n");
    expect(text).not.toContain(TOKEN);
  });

  it("passes API errors through, flattened (409 session_not_joinable)", async () => {
    reply = () =>
      Response.json({ detail: { code: "session_not_joinable", message: "x" } }, { status: 409 });
    const res = await callToken(post("/api/sessions/s1/call-token"), params("s1"));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "session_not_joinable", message: "x" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses bad ids and signed-out users without calling the API", async () => {
    expect((await callToken(post("/api/sessions/x/call-token"), params("../x"))).status).toBe(404);
    jar.delete("ap_session");
    expect((await callToken(post("/api/sessions/s1/call-token"), params("s1"))).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("creating a call", () => {
  it("sends kind call (anything else is a chat) with the Idempotency-Key", async () => {
    reply = () => Response.json({ id: "s2", kind: "call" }, { status: 201 });
    const res = await createSession(
      post(
        "/api/sessions",
        { astrologer_id: "a2", kind: "call", free: false },
        {
          "idempotency-key": "intent-key-call-1",
        },
      ),
    );
    expect(res.status).toBe(201);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      astrologer_id: "a2",
      kind: "call",
      free: false,
    });
    expect(calls[0]!.init.headers["idempotency-key"]).toBe("intent-key-call-1");
    await createSession(post("/api/sessions", { astrologer_id: "a2", kind: "video" }));
    expect(JSON.parse(String(calls[1]!.init.body)).kind).toBe("chat");
  });
});
