import { describe, expect, it } from "vitest";
import { ADMIN_SESSION_MAX_S, sessionCookieFlags } from "../src/lib/cookies";

describe("admin session cookie", () => {
  it("is httpOnly, SameSite=Strict and Secure on https", () => {
    expect(sessionCookieFlags(true)).toMatchObject({
      httpOnly: true,
      sameSite: "strict",
      secure: true,
      path: "/",
    });
    expect(sessionCookieFlags(false).secure).toBe(false);
  });

  it("lives at most 12 hours even if the API token lives 30 days", () => {
    const in30d = new Date(Date.now() + 30 * 86400_000).toISOString();
    expect(sessionCookieFlags(true, in30d).maxAge).toBe(ADMIN_SESSION_MAX_S);
    const in1h = new Date(Date.now() + 3600_000).toISOString();
    expect(sessionCookieFlags(true, in1h).maxAge).toBeLessThanOrEqual(3600);
  });
});
