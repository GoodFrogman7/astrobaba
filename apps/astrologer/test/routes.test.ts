import { describe, expect, it, vi } from "vitest";
import { forward, wsBase, wsUrl } from "../src/lib/forward";
import {
  incomingRoute,
  messagesRoute,
  presenceRoute,
  sessionActionRoute,
  sessionRoute,
} from "../src/lib/routes";

function api(status = 200, body: unknown = { ok: true }) {
  return vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { "set-cookie": "upstream=1" } }),
  );
}

const deps = (fetchImpl: ReturnType<typeof api>, token: string | null = "tok") => ({
  token: token ?? undefined,
  apiUrl: "http://api.test",
  fetchImpl: fetchImpl as unknown as typeof fetch,
  wsBase: "wss://api.example",
});

function sent(f: ReturnType<typeof api>) {
  const [url, init] = f.mock.calls[0]!;
  return { url: String(url), init: init!, headers: init!.headers as Record<string, string> };
}

describe("route forwarding", () => {
  it("forwards the session cookie as a Bearer token and never leaks upstream headers", async () => {
    const f = api(200, { items: [] });
    const res = await incomingRoute(deps(f));
    const { url, headers, init } = sent(f);
    expect(url).toBe("http://api.test/v1/astrologer/me/sessions/incoming");
    expect(init.method).toBe("GET");
    expect(headers.authorization).toBe("Bearer tok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [] });
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("answers 401 without calling the API when signed out", async () => {
    const f = api();
    const res = await incomingRoute(deps(f, null));
    expect(res.status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });

  it("passes API errors through as {code, message} with the same status", async () => {
    const f = api(409, { detail: { code: "invalid_transition", message: "no" } });
    const res = await sessionActionRoute("s_1", "accept", deps(f));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "invalid_transition", message: "no" });
  });

  it("maps an unreachable API to 503", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const res = await forward("GET", "/v1/x", {
      token: "t",
      apiUrl: "http://api.test",
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(res.status).toBe(503);
  });
});

describe("presence route", () => {
  it("accepts only online/offline", async () => {
    const f = api();
    expect((await presenceRoute({ status: "busy" }, deps(f))).status).toBe(400);
    expect((await presenceRoute(null, deps(f))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
    await presenceRoute({ status: "online", extra: 1 }, deps(f));
    const { url, init } = sent(f);
    expect(url).toBe("http://api.test/v1/astrologer/me/presence");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ status: "online" });
  });
});

describe("session routes", () => {
  it("rejects odd ids and unknown actions before calling the API", async () => {
    const f = api();
    expect((await sessionRoute("../admin", deps(f))).status).toBe(404);
    expect((await sessionActionRoute("s_1", "refund", deps(f))).status).toBe(404);
    expect((await sessionActionRoute("s/1", "end", deps(f))).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });

  it.each(["accept", "decline", "end"])("%s → POST /v1/sessions/{id}/%s", async (action) => {
    const f = api();
    await sessionActionRoute("s_1", action, deps(f));
    expect(sent(f).url).toBe(`http://api.test/v1/sessions/s_1/${action}`);
    expect(sent(f).init.method).toBe("POST");
  });

  it("validates and normalises the messages query", async () => {
    const f = api(200, { items: [] });
    expect((await messagesRoute("s_1", new URLSearchParams("after_seq=-1"), deps(f))).status).toBe(
      400,
    );
    expect((await messagesRoute("s_1", new URLSearchParams("limit=500"), deps(f))).status).toBe(
      400,
    );
    await messagesRoute("s_1", new URLSearchParams("after_seq=007&x=1"), deps(f));
    expect(sent(f).url).toBe("http://api.test/v1/sessions/s_1/messages?after_seq=7&limit=200");
  });

  it("turns a ws ticket into a socket URL on the API's WebSocket origin", async () => {
    const f = api(200, { ticket: "abc+/=", expires_in: 30, path: "/v1/sessions/s_1/ws" });
    const res = await sessionActionRoute("s_1", "ws-ticket", deps(f));
    expect(await res.json()).toEqual({
      url: "wss://api.example/v1/sessions/s_1/ws?ticket=abc%2B%2F%3D",
      expires_in: 30,
    });
  });

  it("refuses a ticket path outside /v1/sessions/{id}/ws", async () => {
    const f = api(200, { ticket: "t", path: "//evil.example/x" });
    expect((await sessionActionRoute("s_1", "ws-ticket", deps(f))).status).toBe(502);
  });
});

describe("ws url helpers", () => {
  it("needs a ws(s) origin", () => {
    expect(wsUrl("http://api", "/v1/sessions/s/ws", "t")).toBeNull();
    expect(wsUrl("ws://localhost:8000/", "/v1/sessions/s/ws", "t")).toBe(
      "ws://localhost:8000/v1/sessions/s/ws?ticket=t",
    );
  });

  it("reads the server-side variable first, then the public one", () => {
    expect(wsBase({ API_WS_URL: "wss://a/", NEXT_PUBLIC_API_WS_URL: "wss://b" })).toBe("wss://a");
    expect(wsBase({ NEXT_PUBLIC_API_WS_URL: "wss://b" })).toBe("wss://b");
    expect(wsBase({})).toBe("ws://localhost:8000");
  });
});
