import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same harness as payout-actions.test.ts: Next server modules stubbed, network mocked, so the
// guard → API client → headers chain runs for real. The trust API (docs/api/trust.md §2, §4) is
// built in parallel, so these tests pin the contract.
vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ap_admin_session" ? { value: "admin-token" } : undefined),
  }),
}));

const { actOnModeration, revealFlaggedMessage } = await import("../src/app/moderation/actions");
const { executeDeletion } = await import("../src/app/privacy/deletions/actions");

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
let calls: Call[] = [];
let roles = ["admin"];
let apiResponse: () => Response = () => Response.json({});

function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const toApi = () => calls.filter((c) => !c.url.endsWith("/v1/me"));
const conflict = (code: string) => () =>
  Response.json({ detail: { code, message: code } }, { status: 409 });

beforeEach(() => {
  calls = [];
  roles = ["admin"];
  revalidatePath.mockClear();
  apiResponse = () => Response.json({});
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
      return apiResponse();
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("moderation actions", () => {
  it("posts {action, note} with the admin's Bearer token", async () => {
    const r = await actOnModeration(
      "mod_1",
      null,
      form({ action: "warn", note: "  Told the client a curse would follow  " }),
    );
    expect(r).toEqual({
      ok: true,
      message: "Warning recorded. The astrologer sees the strike in their portal.",
    });
    const [post] = toApi();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/moderation/mod_1");
    expect(post!.method).toBe("POST");
    expect(post!.headers.authorization).toBe("Bearer admin-token");
    expect(post!.headers["content-type"]).toBe("application/json");
    expect(post!.body).toEqual({ action: "warn", note: "Told the client a curse would follow" });
    expect(revalidatePath).toHaveBeenCalledWith("/moderation");
  });

  it("sends suspend and dismiss as given", async () => {
    await actOnModeration("mod_1", null, form({ action: "suspend", note: "Repeated scams" }));
    await actOnModeration("mod_2", null, form({ action: "dismiss", note: "Not a breach" }));
    expect(toApi().map((c) => c.body)).toEqual([
      { action: "suspend", note: "Repeated scams" },
      { action: "dismiss", note: "Not a breach" },
    ]);
  });

  it("requires a known action and a note, without calling the API", async () => {
    expect(await actOnModeration("mod_1", null, form({ action: "warn", note: "" }))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/note/),
    });
    expect(
      (await actOnModeration("mod_1", null, form({ action: "ban", note: "Bad behaviour" }))).ok,
    ).toBe(false);
    expect(
      (await actOnModeration("../x", null, form({ action: "warn", note: "Bad behaviour" }))).ok,
    ).toBe(false);
    expect(calls).toEqual([]);
  });

  it("explains a stale item or a suspend of a non-live astrologer in plain words", async () => {
    apiResponse = conflict("invalid_transition");
    const r = await actOnModeration(
      "mod_1",
      null,
      form({ action: "suspend", note: "Scam reports" }),
    );
    expect(r).toMatchObject({ ok: false, retryable: false });
    if (!r.ok) expect(r.error).toMatch(/only live astrologers can be suspended/);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("never posts for non-admins", async () => {
    roles = [];
    expect(
      await actOnModeration("mod_1", null, form({ action: "warn", note: "Bad behaviour" })),
    ).toEqual({ ok: false, error: "Not authorised." });
    expect(toApi()).toEqual([]);
  });
});

describe("reveal flagged message", () => {
  it("GETs the one message with the Bearer token and returns its text", async () => {
    apiResponse = () =>
      Response.json({
        seq: 7,
        sender: "user",
        text: "flagged text",
        sent_at: "2026-10-21T10:00:00Z",
      });
    const r = await revealFlaggedMessage("mod_9");
    expect(r).toEqual({
      ok: true,
      message: { seq: 7, sender: "user", text: "flagged text", sent_at: "2026-10-21T10:00:00Z" },
    });
    const [get] = toApi();
    expect(get!.url).toBe("http://localhost:8000/v1/admin/moderation/mod_9/message");
    expect(get!.method).toBe("GET");
    expect(get!.headers.authorization).toBe("Bearer admin-token");
    // Nothing is cached or revalidated around the decrypted text.
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("accepts {message: {...}} too, and reports a missing text", async () => {
    apiResponse = () => Response.json({ message: { text: "inner" } });
    expect(await revealFlaggedMessage("mod_9")).toEqual({ ok: true, message: { text: "inner" } });
    apiResponse = () => Response.json({});
    expect((await revealFlaggedMessage("mod_9")).ok).toBe(false);
  });

  it("is refused for non-admins before any API call for the message", async () => {
    roles = ["support"];
    expect(await revealFlaggedMessage("mod_9")).toEqual({ ok: false, error: "Not authorised." });
    expect(toApi()).toEqual([]);
  });

  it("shows API errors in plain words", async () => {
    apiResponse = () =>
      Response.json({ detail: { code: "not_found", message: "nope" } }, { status: 404 });
    expect(await revealFlaggedMessage("mod_9")).toEqual({
      ok: false,
      error: "This item no longer exists. Reload the list.",
    });
  });
});

describe("execute deletion", () => {
  it("posts to the execute endpoint with the Bearer token and no body", async () => {
    const r = await executeDeletion("del_1");
    expect(r.ok).toBe(true);
    const [post] = toApi();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/deletions/del_1/execute");
    expect(post!.method).toBe("POST");
    expect(post!.headers.authorization).toBe("Bearer admin-token");
    expect(post!.body).toBeUndefined();
    expect(revalidatePath).toHaveBeenCalledWith("/privacy/deletions");
  });

  it("explains 409 balance_outstanding with what to do", async () => {
    apiResponse = conflict("balance_outstanding");
    const r = await executeDeletion("del_1");
    expect(r).toMatchObject({ ok: false, retryable: false });
    if (!r.ok) {
      expect(r.error).toMatch(/still has money in their wallet/);
      expect(r.error).toMatch(/Settle the balance manually first/);
      expect(r.error).toMatch(/Nothing was deleted/);
    }
  });

  it("explains 409 session_open with what to do", async () => {
    apiResponse = conflict("session_open");
    const r = await executeDeletion("del_1");
    if (!r.ok) expect(r.error).toMatch(/consultation that is waiting or in progress.*Wait for it/);
    else throw new Error("expected a refusal");
  });

  it("marks an unreachable API as retryable and refuses odd ids", async () => {
    apiResponse = () => new Response("bad gateway", { status: 502 });
    expect(await executeDeletion("del_1")).toMatchObject({ ok: false, retryable: true });
    calls = [];
    expect((await executeDeletion("del/../1")).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("never posts for non-admins", async () => {
    roles = [];
    expect(await executeDeletion("del_1")).toEqual({ ok: false, error: "Not authorised." });
    expect(toApi()).toEqual([]);
  });
});
