import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same harness as money-actions.test.ts: Next server modules stubbed, network mocked, so the
// guard → API client → headers chain runs for real.
vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
let cookieToken: string | undefined = "admin-token";
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ap_admin_session" && cookieToken ? { value: cookieToken } : undefined,
  }),
}));

const { approvePayout, generatePayouts, markPayoutPaid, voidPayout } =
  await import("../src/app/money/payouts/actions");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let roles = ["admin"];
let postResponse: () => Response = () => Response.json({});

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const posts = () => calls.filter((c) => c.method === "POST");

beforeEach(() => {
  calls = [];
  roles = ["admin"];
  cookieToken = "admin-token";
  revalidatePath.mockClear();
  postResponse = () => Response.json({});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T06:00:00Z"));
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
      if (url.endsWith("/v1/me")) return Response.json({ id: "a1", phone: "+91•••", roles });
      return postResponse();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("generate", () => {
  it("posts the period with the admin's Bearer token and reports the count", async () => {
    postResponse = () => Response.json({ generated: 14 });
    const r = await generatePayouts(null, form({ period: "2026-09" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toMatch(/September 2026 generated \(14\)/);
    const [post] = posts();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/payouts/generate");
    expect(post!.headers.authorization).toBe("Bearer admin-token");
    expect(post!.headers["content-type"]).toBe("application/json");
    expect(post!.body).toEqual({ period: "2026-09" });
    expect(revalidatePath).toHaveBeenCalledWith("/money/payouts");
  });

  it("refuses the current or a malformed month without calling the API", async () => {
    expect((await generatePayouts(null, form({ period: "2026-10" }))).ok).toBe(false);
    expect((await generatePayouts(null, form({ period: "Sept" }))).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("approve", () => {
  it("posts to the payout's approve endpoint", async () => {
    const r = await approvePayout("po_1");
    expect(r.ok).toBe(true);
    const [post] = posts();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/payouts/po_1/approve");
    expect(post!.headers.authorization).toBe("Bearer admin-token");
    expect(post!.body).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/money/payouts/po_1");
  });

  it("explains a stale state in plain words", async () => {
    postResponse = () =>
      Response.json(
        { detail: { code: "invalid_transition", message: "invalid_transition" } },
        { status: 409 },
      );
    const r = await approvePayout("po_1");
    expect(r).toMatchObject({ ok: false, retryable: false });
    if (!r.ok) expect(r.error).toMatch(/no longer in a state/);
  });

  it("refuses odd ids", async () => {
    expect((await approvePayout("../x")).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("mark paid", () => {
  it("posts the bank reference and paid-on date", async () => {
    const r = await markPayoutPaid(
      "po_1",
      null,
      form({ reference: " UTIB0001234567 ", paid_on: "2026-10-20" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toMatch(/payout:po_1 was posted/);
    const [post] = posts();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/payouts/po_1/mark-paid");
    expect(post!.headers.authorization).toBe("Bearer admin-token");
    expect(post!.body).toEqual({ reference: "UTIB0001234567", paid_on: "2026-10-20" });
  });

  it("shows 409 exceeds_payable in plain words, as a definite answer", async () => {
    postResponse = () =>
      Response.json(
        { detail: { code: "exceeds_payable", message: "exceeds_payable" } },
        { status: 409 },
      );
    const r = await markPayoutPaid(
      "po_1",
      null,
      form({ reference: "UTIB0001234567", paid_on: "2026-10-20" }),
    );
    expect(r).toMatchObject({ ok: false, retryable: false });
    if (!r.ok) expect(r.error).toMatch(/more than the astrologer's payable balance/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("marks an unreachable API as retryable (the payout key prevents a double posting)", async () => {
    postResponse = () => new Response("bad gateway", { status: 502 });
    const r = await markPayoutPaid(
      "po_1",
      null,
      form({ reference: "UTIB0001234567", paid_on: "2026-10-20" }),
    );
    expect(r).toMatchObject({ ok: false, retryable: true });
  });

  it("never posts without a valid reference and date", async () => {
    expect(
      (await markPayoutPaid("po_1", null, form({ reference: "", paid_on: "2026-10-20" }))).ok,
    ).toBe(false);
    expect(
      (await markPayoutPaid("po_1", null, form({ reference: "UTR12345", paid_on: "2026-10-22" })))
        .ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("void", () => {
  it("posts the note", async () => {
    const r = await voidPayout("po_1", null, form({ note: "Duplicate statement" }));
    expect(r.ok).toBe(true);
    const [post] = posts();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/payouts/po_1/void");
    expect(post!.body).toEqual({ note: "Duplicate statement" });
  });

  it("requires a note", async () => {
    expect((await voidPayout("po_1", null, form({ note: "" }))).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("access", () => {
  it("never posts for non-admins", async () => {
    roles = [];
    expect(await approvePayout("po_1")).toEqual({ ok: false, error: "Not authorised." });
    expect(await voidPayout("po_1", null, form({ note: "Duplicate statement" }))).toEqual({
      ok: false,
      error: "Not authorised.",
    });
    expect(posts()).toEqual([]);
  });
});
