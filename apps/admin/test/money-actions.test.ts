import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The actions run server-side in Next; here the Next/React server modules are stubbed and the
// network is a mocked fetch, so the whole chain (guard → API client → headers) is exercised.
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
let cookieToken: string | undefined = "admin-token";
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ap_admin_session" && cookieToken ? { value: cookieToken } : undefined,
  }),
}));

const { manualRefund, overrideFreeSession, runReconciliation } =
  await import("../src/app/money/actions");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let roles = ["admin"];
let postResponse: () => Response = () => new Response("{}", { status: 201 });

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  calls = [];
  roles = ["admin"];
  cookieToken = "admin-token";
  postResponse = () => new Response("{}", { status: 201 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
      calls.push({
        url,
        method: init.method ?? "GET",
        headers,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/v1/me")) {
        return Response.json({ id: "a1", phone: "+91•••", roles });
      }
      return postResponse();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const refund = {
  session_id: "ses_1",
  amount_rupees: "120.50",
  note: "Goodwill: audio issues",
  idempotency_key: "adm_key_0001",
};

describe("manual refund action", () => {
  it("forwards the admin's session as Bearer and passes the Idempotency-Key through", async () => {
    const r = await manualRefund(null, form(refund));
    expect(r).toEqual({ ok: true, message: "Refund of ₹120.50 recorded for session ses_1." });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("http://localhost:8000/v1/admin/money/refunds");
    expect(post.headers.authorization).toBe("Bearer admin-token");
    expect(post.headers["idempotency-key"]).toBe("adm_key_0001");
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.body).toEqual({
      session_id: "ses_1",
      amount_paise: 12050,
      note: "Goodwill: audio issues",
    });
  });

  it("reuses the same key on retry (the key comes from the form, never regenerated)", async () => {
    postResponse = () => new Response("bad gateway", { status: 502 });
    const first = await manualRefund(null, form(refund));
    expect(first).toMatchObject({ ok: false, retryable: true });
    postResponse = () => new Response("{}", { status: 201 });
    await manualRefund(first, form(refund));
    const keys = calls.filter((c) => c.method === "POST").map((c) => c.headers["idempotency-key"]);
    expect(keys).toEqual(["adm_key_0001", "adm_key_0001"]);
  });

  it("marks an unreachable API as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/v1/me")) return Response.json({ id: "a", phone: "x", roles: ["admin"] });
        throw new TypeError("fetch failed");
      }),
    );
    expect(await manualRefund(null, form(refund))).toMatchObject({ ok: false, retryable: true });
  });

  it("treats a 4xx as a definite answer and explains an idempotency conflict", async () => {
    postResponse = () =>
      Response.json(
        {
          detail: {
            code: "idempotency_conflict",
            message: "This Idempotency-Key was used for another request.",
          },
        },
        { status: 409 },
      );
    const r = await manualRefund(null, form(refund));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.retryable).toBe(false);
      expect(r.error).toContain("already used for a different refund");
    }
    postResponse = () =>
      Response.json({ detail: { code: "amount_too_high", message: "Too high" } }, { status: 422 });
    expect(await manualRefund(null, form(refund))).toMatchObject({
      ok: false,
      error: "Too high",
      retryable: false,
    });
  });

  it("never posts for non-admins or invalid input", async () => {
    roles = [];
    expect(await manualRefund(null, form(refund))).toEqual({ ok: false, error: "Not authorised." });
    roles = ["admin"];
    expect((await manualRefund(null, form({ ...refund, amount_rupees: "abc" }))).ok).toBe(false);
    cookieToken = undefined;
    expect((await manualRefund(null, form(refund))).ok).toBe(false);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

describe("free session override action", () => {
  it("posts the override with the admin's token", async () => {
    const r = await overrideFreeSession(
      "u_9",
      null,
      form({ action: "block", note: "same device x3" }),
    );
    expect(r.ok).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("http://localhost:8000/v1/admin/money/free-sessions/override");
    expect(post.headers.authorization).toBe("Bearer admin-token");
    expect(post.body).toEqual({ user_id: "u_9", action: "block", note: "same device x3" });
  });
});

describe("reconciliation run action", () => {
  it("posts the chosen date", async () => {
    const r = await runReconciliation(null, form({ date: "2026-10-01" }));
    expect(r.ok).toBe(true);
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("http://localhost:8000/v1/admin/money/reconciliation/run");
    expect(post.body).toEqual({ date: "2026-10-01" });
  });

  it("refuses future dates without calling the API", async () => {
    expect((await runReconciliation(null, form({ date: "2999-01-01" }))).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
