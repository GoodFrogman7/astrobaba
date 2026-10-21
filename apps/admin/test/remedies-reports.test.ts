import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { leadStatusFilter, parseLeadUpdate, safePhone, LEAD_NOTE_MAX } from "../src/lib/remedies";
import {
  canRetry,
  ownerOf,
  reportErrorText,
  reportStatusFilter,
  type AdminReportRow,
} from "../src/lib/reports-admin";

// Same harness as payout-actions.test.ts: Next server modules stubbed, network mocked, so the
// guard → API client → headers chain runs for real. The reports admin API (revenue.md §2.3a) is
// built in parallel, so these tests pin the contract.
vi.mock("server-only", () => ({}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ap_admin_session" ? { value: "admin-token" } : undefined),
  }),
}));

const { updateLead } = await import("../src/app/remedies/actions");
const { retryReport } = await import("../src/app/reports/actions");

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
  revalidatePath.mockClear();
  postResponse = () => Response.json({});
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
});

describe("remedy lead helpers", () => {
  it("accepts only known status filters", () => {
    expect(leadStatusFilter("spam")).toBe("spam");
    expect(leadStatusFilter("deleted")).toBeNull();
    expect(leadStatusFilter(undefined)).toBeNull();
  });

  it("parses an update: an admin cannot set `new`, and the note is bounded", () => {
    expect(parseLeadUpdate({ status: "contacted", note: "  called  " })).toEqual({
      ok: true,
      value: { status: "contacted", note: "called" },
    });
    expect(parseLeadUpdate({ status: "new", note: "" }).ok).toBe(false);
    expect(parseLeadUpdate({ status: "", note: "" }).ok).toBe(false);
    expect(parseLeadUpdate({ status: "spam", note: "x".repeat(LEAD_NOTE_MAX + 1) }).ok).toBe(false);
  });

  it("never shows a full phone number", () => {
    expect(safePhone("+91•••••45678")).toBe("+91•••••45678");
    expect(safePhone("+919812345678")).toBe("+91•••••45678");
  });
});

describe("updateLead", () => {
  it("posts status and note with the admin's token", async () => {
    postResponse = () => Response.json({ id: "l1", status: "contacted" });
    const r = await updateLead("l1", null, form({ status: "contacted", note: "Partner called" }));
    expect(r).toEqual({ ok: true, message: "Marked contacted." });
    const [post] = posts();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/remedies/leads/l1");
    expect(post!.headers.authorization).toBe("Bearer admin-token");
    expect(post!.body).toEqual({ status: "contacted", note: "Partner called" });
    expect(revalidatePath).toHaveBeenCalledWith("/remedies");
  });

  it("refuses bad input and odd ids without calling the API", async () => {
    expect((await updateLead("l1", null, form({ status: "new" }))).ok).toBe(false);
    expect((await updateLead("../x", null, form({ status: "spam" }))).ok).toBe(false);
    expect(posts()).toEqual([]);
  });

  it("explains a missing lead", async () => {
    postResponse = () =>
      Response.json({ detail: { code: "not_found", message: "Lead not found." } }, { status: 404 });
    const r = await updateLead("l1", null, form({ status: "spam" }));
    expect(r).toMatchObject({ ok: false, retryable: false, error: "This lead no longer exists." });
  });

  it("never posts for non-admins", async () => {
    roles = [];
    expect(await updateLead("l1", null, form({ status: "spam" }))).toEqual({
      ok: false,
      error: "Not authorised.",
    });
    expect(posts()).toEqual([]);
  });
});

describe("report helpers", () => {
  const row: AdminReportRow = {
    id: "r1",
    user_id: "u1",
    sku: "kundli_report",
    status: "failed",
    attempts: 5,
    last_error_code: "render_failed",
    created_at: "2026-10-21T06:00:00Z",
  };

  it("retries only failed reports and reads the owner id", () => {
    expect(canRetry(row)).toBe(true);
    expect(canRetry({ ...row, status: "ready" })).toBe(false);
    expect(ownerOf(row)).toBe("u1");
    expect(ownerOf({ ...row, user_id: undefined, owner_id: "u2" })).toBe("u2");
    expect(reportStatusFilter("failed")).toBe("failed");
    expect(reportStatusFilter("refunded")).toBeNull();
    expect(reportErrorText("not_found")).toMatch(/no longer exists/);
  });
});

describe("retryReport", () => {
  it("posts charge_again: false to the retry endpoint", async () => {
    const r = await retryReport("r1");
    expect(r.ok).toBe(true);
    const [post] = posts();
    expect(post!.url).toBe("http://localhost:8000/v1/admin/reports/r1/retry");
    expect(post!.headers.authorization).toBe("Bearer admin-token");
    expect(post!.body).toEqual({ charge_again: false });
    expect(revalidatePath).toHaveBeenCalledWith("/reports");
  });

  it("explains a report that is no longer failed", async () => {
    postResponse = () =>
      Response.json(
        { detail: { code: "invalid_transition", message: "invalid_transition" } },
        { status: 409 },
      );
    const r = await retryReport("r1");
    expect(r).toMatchObject({ ok: false, retryable: false });
    if (!r.ok) expect(r.error).toMatch(/Only a failed report/);
  });

  it("marks an unreachable API as retryable and refuses odd ids", async () => {
    postResponse = () => new Response("bad gateway", { status: 502 });
    expect(await retryReport("r1")).toMatchObject({ ok: false, retryable: true });
    calls = [];
    expect((await retryReport("a/b")).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("never posts for non-admins", async () => {
    roles = [];
    expect(await retryReport("r1")).toEqual({ ok: false, error: "Not authorised." });
    expect(posts()).toEqual([]);
  });
});
