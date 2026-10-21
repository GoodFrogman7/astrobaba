import { describe, expect, it, vi } from "vitest";
import { decideAccess, withLiveAstrologer } from "../src/lib/access";
import { isHttps, sessionCookieFlags } from "../src/lib/cookies";
import type { Me } from "../src/lib/types";

const me = (astrologer: Me["astrologer"]): Me => ({ id: "u1", phone: "+91•••••43210", astrologer });

describe("console access", () => {
  it("classifies sessions", () => {
    expect(decideAccess(null).kind).toBe("anon");
    expect(decideAccess(me(null)).kind).toBe("not_astrologer");
    for (const status of [
      "applied",
      "kyc_submitted",
      "interview",
      "suspended",
      "rejected",
    ] as const) {
      expect(decideAccess(me({ id: "a", status, slug: null }))).toMatchObject({
        kind: "not_live",
        status,
      });
    }
    expect(decideAccess(me({ id: "a", status: "probation", slug: "x" })).kind).toBe("live");
    expect(decideAccess(me({ id: "a", status: "approved", slug: "x" })).kind).toBe("live");
  });

  it("never loads data unless live", async () => {
    for (const m of [null, me(null), me({ id: "a", status: "interview", slug: null })]) {
      const load = vi.fn(async () => "x");
      expect((await withLiveAstrologer(async () => m, load)).data).toBeNull();
      expect(load).not.toHaveBeenCalled();
    }
  });
});

describe("session cookie", () => {
  it("is httpOnly, strict and at most 12 h", () => {
    const far = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    expect(sessionCookieFlags(true, far)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 3600,
    });
    expect(isHttps("http://x", "https")).toBe(true);
    expect(isHttps("http://x", null)).toBe(false);
  });
});
