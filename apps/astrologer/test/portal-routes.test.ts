import { describe, expect, it, vi } from "vitest";
import nextConfig from "../next.config";
import {
  availabilityRoute,
  consultRoute,
  reviewReplyRoute,
  safeDisposition,
  statementCsvRoute,
} from "../src/lib/portal-routes";
import { sessionActionRoute } from "../src/lib/routes";
import { api, deps, sent } from "./fixtures";

describe("call token", () => {
  const good = {
    url: "wss://lk.example",
    token: "jwt",
    room: "session-s_1",
    identity: "astrologer",
    expires_in: 600,
    extra: "dropped",
  };

  it("is whitelisted and forwarded with the Bearer token", async () => {
    const f = api(200, good);
    const res = await sessionActionRoute("s_1", "call-token", deps(f));
    expect(sent(f).url).toBe("http://api.test/v1/sessions/s_1/call-token");
    expect(sent(f).init.method).toBe("POST");
    expect(sent(f).headers.authorization).toBe("Bearer tok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "wss://lk.example",
      token: "jwt",
      room: "session-s_1",
      identity: "astrologer",
      expires_in: 600,
    });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses a token for another room, identity or URL scheme", async () => {
    for (const bad of [
      { ...good, room: "session-other" },
      { ...good, identity: "user" },
      { ...good, url: "javascript:alert(1)" },
      { ...good, token: "" },
    ]) {
      expect((await sessionActionRoute("s_1", "call-token", deps(api(200, bad)))).status).toBe(502);
    }
  });

  it("passes refusals through and never calls the API for odd ids or actions", async () => {
    const res = await sessionActionRoute(
      "s_1",
      "call-token",
      deps(api(409, { detail: { code: "session_not_joinable", message: "no" } })),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "session_not_joinable", message: "no" });
    const f = api();
    expect((await sessionActionRoute("s/1", "call-token", deps(f))).status).toBe(404);
    expect((await sessionActionRoute("s_1", "call-tokens", deps(f))).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("availability route", () => {
  it("rebuilds the body from slot fields only and PUTs it", async () => {
    const f = api(200, { timezone: "Asia/Kolkata", slots: [] });
    const res = await availabilityRoute(
      { slots: [{ weekday: 0, start: "09:00", end: "13:00", note: "x" }], other: 1 },
      deps(f),
    );
    expect(res.status).toBe(200);
    const s = sent(f);
    expect(s.url).toBe("http://api.test/v1/astrologer/me/availability");
    expect(s.init.method).toBe("PUT");
    expect(s.headers.authorization).toBe("Bearer tok");
    expect(s.body).toEqual({ slots: [{ weekday: 0, start: "09:00", end: "13:00" }] });
  });

  it("refuses malformed shapes without calling the API (rules stay with the API)", async () => {
    const f = api();
    const bad = [
      null,
      {},
      { slots: "x" },
      { slots: [{ weekday: 7, start: "09:00", end: "10:00" }] },
      { slots: [{ weekday: 1.5, start: "09:00", end: "10:00" }] },
      { slots: [{ weekday: 1, start: "9:00", end: "10:00" }] },
      { slots: Array.from({ length: 22 }, () => ({ weekday: 0, start: "09:00", end: "10:00" })) },
    ];
    for (const b of bad) expect((await availabilityRoute(b, deps(f))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("passes 422 invalid_slots through with its index", async () => {
    const f = api(422, { detail: { code: "invalid_slots", message: "overlap", index: 1 } });
    const res = await availabilityRoute(
      { slots: [{ weekday: 0, start: "09:00", end: "10:00" }] },
      deps(f),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ code: "invalid_slots", message: "overlap", index: 1 });
  });

  it("answers 401 when signed out", async () => {
    const f = api();
    expect((await availabilityRoute({ slots: [] }, deps(f, null))).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("consult route", () => {
  it("PATCHes only boolean toggles", async () => {
    const f = api(200, { chat_enabled: true, call_enabled: true, voice_calls_available: true });
    await consultRoute({ call_enabled: true, price_per_min_paise: 1 }, deps(f));
    const s = sent(f);
    expect(s.url).toBe("http://api.test/v1/astrologer/me/consult");
    expect(s.init.method).toBe("PATCH");
    expect(s.body).toEqual({ call_enabled: true });
  });

  it("refuses empty or non-boolean patches", async () => {
    const f = api();
    expect((await consultRoute({}, deps(f))).status).toBe(400);
    expect((await consultRoute({ chat_enabled: "yes" }, deps(f))).status).toBe(400);
    expect((await consultRoute(null, deps(f))).status).toBe(400);
    expect(f).not.toHaveBeenCalled();
  });

  it("passes 409 call_unavailable through", async () => {
    const f = api(409, { detail: { code: "call_unavailable", message: "off" } });
    const res = await consultRoute({ call_enabled: true }, deps(f));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("call_unavailable");
  });
});

describe("review reply route", () => {
  it("posts the trimmed text to the review", async () => {
    const f = api(200, { id: "r_1", reply: { text: "Thank you", at: "2026-10-21T10:00:00Z" } });
    await reviewReplyRoute("r_1", { text: "  Thank you  ", rating: 5 }, deps(f));
    const s = sent(f);
    expect(s.url).toBe("http://api.test/v1/reviews/r_1/reply");
    expect(s.init.method).toBe("POST");
    expect(s.headers.authorization).toBe("Bearer tok");
    expect(s.body).toEqual({ text: "Thank you" });
  });

  it("refuses odd ids, empty and over-long text before calling the API", async () => {
    const f = api();
    expect((await reviewReplyRoute("../x", { text: "hi" }, deps(f))).status).toBe(404);
    expect((await reviewReplyRoute("r_1", { text: "   " }, deps(f))).status).toBe(400);
    expect((await reviewReplyRoute("r_1", { text: 5 }, deps(f))).status).toBe(400);
    expect((await reviewReplyRoute("r_1", { text: "x".repeat(1001) }, deps(f))).status).toBe(422);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("statement CSV route", () => {
  const csv = "session_id,net_paise\ns_1,2000\nTOTAL,2000\n";

  it("streams the CSV with only content-type and content-disposition", async () => {
    const f = api(200, csv, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="statement-2026-09.csv"',
      server: "uvicorn",
      "x-request-id": "abc",
    });
    const res = await statementCsvRoute("p_1", deps(f));
    expect(sent(f).url).toBe("http://api.test/v1/astrologer/me/payouts/p_1/statement.csv");
    expect(sent(f).headers.authorization).toBe("Bearer tok");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(csv);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="statement-2026-09.csv"',
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("server")).toBeNull();
    expect(res.headers.get("x-request-id")).toBeNull();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect([...res.headers.keys()].sort()).toEqual([
      "cache-control",
      "content-disposition",
      "content-type",
    ]);
  });

  it("forces an attachment when the API sends none or an inline one", async () => {
    const f = api(200, csv, { "content-type": "text/csv", "content-disposition": "inline" });
    const res = await statementCsvRoute("p_1", deps(f));
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="statement-p_1.csv"');
    expect(safeDisposition(null, "p_1")).toBe('attachment; filename="statement-p_1.csv"');
  });

  it("refuses anything that is not CSV (never serves upstream HTML from this origin)", async () => {
    const f = api(200, "<script>x</script>", { "content-type": "text/html" });
    expect((await statementCsvRoute("p_1", deps(f))).status).toBe(502);
  });

  it("maps API errors to {code, message}, keeps 401/404 and checks the id", async () => {
    const f = api(404, { detail: { code: "not_found", message: "Payout not found." } });
    const res = await statementCsvRoute("p_1", deps(f));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: "not_found", message: "Payout not found." });
    const g = api();
    expect((await statementCsvRoute("p/1", deps(g))).status).toBe(404);
    expect((await statementCsvRoute("p_1", deps(g, null))).status).toBe(401);
    expect(g).not.toHaveBeenCalled();
  });

  it("maps an unreachable API to 503", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      (await statementCsvRoute("p_1", { token: "t", apiUrl: "http://api.test", fetchImpl: f }))
        .status,
    ).toBe(503);
  });
});

describe("security headers", () => {
  it("allow the microphone for this origin only; camera and location stay off", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const pp = all.headers.find((h) => h.key === "Permissions-Policy")!.value;
    expect(pp).toContain("microphone=(self)");
    expect(pp).toContain("camera=()");
    expect(pp).toContain("geolocation=()");
  });
});
