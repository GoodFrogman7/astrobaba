import { describe, expect, it, vi } from "vitest";
import type { ConsentState } from "@astro/shared";
import { chatReducer, initialChatState, type ChatState } from "../src/lib/chat/reducer";
import { consentRoute, safetyResourcesRoute } from "../src/lib/portal-routes";
import {
  acceptTerms,
  acceptedAt,
  blockedNotice,
  blockedReasonText,
  isConsentRequired,
  needsAstrologerTerms,
  normalizeResources,
  normalizeStrikes,
  safeNext,
  strikeReasonLabel,
  telHref,
  termsGate,
  termsHref,
} from "../src/lib/trust";
import { api, deps, msg, sent, session } from "./fixtures";

const consents = (accepted: ConsentState["accepted"], version = "2026-10-21"): ConsentState => ({
  version,
  required: ["astrologer_terms"],
  missing: [],
  accepted,
  current: false,
});

describe("astrologer terms gate", () => {
  it("needs the terms until astrologer_terms is accepted for the current version", () => {
    expect(needsAstrologerTerms(consents([]))).toBe(true);
    // A user consent does not count, nor does an older version of the astrologer terms.
    expect(
      needsAstrologerTerms(
        consents([
          { kind: "terms", version: "2026-10-21", accepted_at: "2026-10-21T05:00:00Z" },
          { kind: "astrologer_terms", version: "2026-09-01", accepted_at: "2026-09-01T05:00:00Z" },
        ]),
      ),
    ).toBe(true);
    const ok = consents([
      { kind: "astrologer_terms", version: "2026-10-21", accepted_at: "2026-10-21T05:00:00Z" },
    ]);
    expect(needsAstrologerTerms(ok)).toBe(false);
    expect(acceptedAt(ok)).toBe("2026-10-21T05:00:00Z");
  });

  it("gates with the current version, and stays open when consents can't be read", async () => {
    expect(await termsGate(async () => consents([]))).toEqual({
      gate: true,
      version: "2026-10-21",
    });
    expect(
      await termsGate(async () =>
        consents([
          { kind: "astrologer_terms", version: "2026-10-21", accepted_at: "2026-10-21T05:00:00Z" },
        ]),
      ),
    ).toEqual({ gate: false });
    // The API still refuses portal writes (403 consent_required), which opens the gate there.
    expect(
      await termsGate(async () => {
        throw new Error("down");
      }),
    ).toEqual({ gate: false });
    expect(await termsGate(async () => ({}) as ConsentState)).toEqual({ gate: false });
  });

  it("recognises 403 consent_required from a portal write", () => {
    expect(
      isConsentRequired(403, { code: "consent_required", missing: ["astrologer_terms"] }),
    ).toBe(true);
    expect(isConsentRequired(403, { code: "forbidden" })).toBe(false);
    expect(isConsentRequired(409, { code: "consent_required" })).toBe(false);
    expect(isConsentRequired(403, null)).toBe(false);
  });

  it("brings the astrologer back to the refused page, same-site only", () => {
    expect(termsHref("/schedule")).toBe("/terms?next=%2Fschedule");
    expect(termsHref("/terms")).toBe("/terms");
    expect(termsHref("//evil.example")).toBe("/terms");
    expect(termsHref(null)).toBe("/terms");
    expect(safeNext("/settings")).toBe("/settings");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });

  it("posts only the version to this app's route and reports the outcome", async () => {
    const ok = api(200, consents([]));
    expect(await acceptTerms("2026-10-21", ok as unknown as typeof fetch)).toEqual({ ok: true });
    expect(sent(ok).url).toBe("/api/consents");
    expect(sent(ok).init.method).toBe("POST");
    expect(sent(ok).body).toEqual({ version: "2026-10-21" });

    const stale = api(409, { code: "consent_version_stale", message: "stale" });
    const r = await acceptTerms("2026-09-01", stale as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, stale: true });
    if (!r.ok) expect(r.error).toMatch(/terms were updated/);

    const down = vi.fn(async () => {
      throw new TypeError("offline");
    });
    expect(await acceptTerms("2026-10-21", down as unknown as typeof fetch)).toEqual({
      ok: false,
      error: "Network error. Try again.",
    });
  });
});

describe("consent route", () => {
  it("forwards with the Bearer token and a fixed astrologer_terms kind", async () => {
    const f = api(200, consents([]));
    const res = await consentRoute({ version: "2026-10-21", kinds: ["age_18", "terms"] }, deps(f));
    expect(res.status).toBe(200);
    expect(sent(f).url).toBe("http://api.test/v1/me/consents");
    expect(sent(f).init.method).toBe("POST");
    expect(sent(f).headers.authorization).toBe("Bearer tok");
    expect(sent(f).body).toEqual({ version: "2026-10-21", kinds: ["astrologer_terms"] });
  });

  it("refuses a missing or odd version without calling the API", async () => {
    const f = api();
    for (const body of [
      {},
      { version: "" },
      { version: "x".repeat(40) },
      { version: "a b" },
      null,
    ]) {
      expect((await consentRoute(body, deps(f))).status).toBe(400);
    }
    expect(f).not.toHaveBeenCalled();
  });

  it("passes 409 consent_version_stale on as {code, message}", async () => {
    const f = api(409, { detail: { code: "consent_version_stale", message: "Version changed" } });
    const res = await consentRoute({ version: "2026-09-01" }, deps(f));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: "consent_version_stale", message: "Version changed" });
  });

  it("is refused signed out", async () => {
    expect((await consentRoute({ version: "2026-10-21" }, deps(api(), null))).status).toBe(401);
  });

  it("fetches the crisis resources", async () => {
    const f = api(200, { helplines: [] });
    await safetyResourcesRoute(deps(f));
    expect(sent(f).url).toBe("http://api.test/v1/safety/resources");
    expect(sent(f).init.method).toBe("GET");
  });
});

describe("refused messages", () => {
  it("says why in plain words, for the contract's reason words", () => {
    expect(blockedReasonText("contact_details")).toMatch(/contact details/);
    expect(blockedReasonText("off_platform_payment")).toMatch(/payment outside the platform/);
    expect(blockedReasonText("cure_claim")).toMatch(/cure an illness/);
    expect(blockedReasonText("guaranteed_outcome")).toMatch(/certain outcome/);
    expect(blockedReasonText("fear_selling")).toMatch(/fear/);
    expect(blockedReasonText("remedy_sale")).toMatch(/remedy, gemstone or product/);
    expect(blockedReasonText("gemstone")).toMatch(/gemstone/);
    expect(blockedReasonText("something_new")).toBe("it breaks the conduct rules");
    expect(blockedReasonText(null)).toBe("it breaks the conduct rules");
    expect(blockedNotice("contact_details")).toBe(
      "Your message was not sent: it contained contact details (a phone number, email, social handle or link). The client did not see it.",
    );
  });

  const typed = (): ChatState => {
    let s: ChatState = { ...initialChatState("astrologer", session()), connection: "open" };
    s = chatReducer(s, { type: "send", client_id: "c1", text: "Call me on my number" });
    return s;
  };
  const blocked = (extra: Record<string, unknown> = {}) =>
    ({
      type: "server",
      now: 0,
      event: { type: "error", code: "message_blocked", message: "Blocked", ...extra },
    }) as Parameters<typeof chatReducer>[1];

  it("marks the message as not sent (no retry) and keeps the reason for the composer", () => {
    const s = chatReducer(typed(), blocked({ reason: "contact_details" }));
    expect(s.pending).toEqual([
      { client_id: "c1", text: "Call me on my number", status: "blocked" },
    ]);
    expect(s.blocked).toEqual({ reason: "contact_details" });
    // Not shown as a generic error: the blocked notice explains it.
    expect(s.error).toBeNull();
  });

  it("marks only the echoed client_id when the server names it", () => {
    let s = chatReducer(typed(), { type: "send", client_id: "c2", text: "Namaste" });
    s = chatReducer(s, blocked({ reason: "contact_details", client_id: "c1" }));
    expect(s.pending.map((p) => p.status)).toEqual(["blocked", "sending"]);
  });

  it("clears the notice on the next send, and a refused message can be removed", () => {
    let s = chatReducer(typed(), blocked({ reason: "fear_selling" }));
    s = chatReducer(s, { type: "discard", client_id: "c1" });
    expect(s.pending).toEqual([]);
    expect(s.blocked).not.toBeNull();
    s = chatReducer(s, { type: "send", client_id: "c3", text: "Let us look at your chart" });
    expect(s.blocked).toBeNull();
    s = chatReducer(s, blocked());
    expect(s.blocked).toEqual({ reason: null });
    expect(chatReducer(s, { type: "dismiss_blocked" }).blocked).toBeNull();
  });

  it("does not turn a refused message into a retryable failure when the session ends", () => {
    let s = chatReducer(typed(), blocked({ reason: "contact_details" }));
    s = chatReducer(s, {
      type: "server",
      now: 0,
      event: { type: "ended", session: session({ status: "completed" }) },
    });
    expect(s.pending[0]!.status).toBe("blocked");
  });
});

describe("safety event", () => {
  it("raises the flag once and keeps it through later frames", () => {
    let s: ChatState = { ...initialChatState("astrologer", session()), connection: "open" };
    expect(s.safety).toBeNull();
    s = chatReducer(s, { type: "server", now: 0, event: { type: "safety", kind: "self_harm" } });
    expect(s.safety).toBe("self_harm");
    const same = chatReducer(s, {
      type: "server",
      now: 1,
      event: { type: "safety", kind: "self_harm" },
    });
    expect(same).toBe(s);
    s = chatReducer(s, { type: "server", now: 2, event: { type: "message", message: msg(5) } });
    s = chatReducer(s, {
      type: "server",
      now: 3,
      event: { type: "state", session: session({ billed_minutes: 3 }) },
    });
    expect(s.safety).toBe("self_harm");
  });
});

describe("strikes", () => {
  it("reads an array or {items} with the obvious field names", () => {
    const items = [
      { id: "st1", reason: "fear_selling", note: "Told the client about a curse", created_at: "x" },
      { id: "st2", reasons: ["off_platform"], at: "y", session_id: "s_9" },
      "junk",
      { note: null },
    ];
    const a = normalizeStrikes(items);
    expect(a).toEqual([
      {
        id: "st1",
        reason: "fear_selling",
        note: "Told the client about a curse",
        at: "x",
        session_id: null,
      },
      { id: "st2", reason: "off_platform", note: null, at: "y", session_id: "s_9" },
      { id: "strike-3", reason: null, note: null, at: null, session_id: null },
    ]);
    expect(normalizeStrikes({ items })).toEqual(a);
    expect(normalizeStrikes(null)).toEqual([]);
    expect(normalizeStrikes({ detail: "x" })).toEqual([]);
  });

  it("labels reasons in plain words", () => {
    expect(strikeReasonLabel("fear_selling")).toBe("Fear selling");
    expect(strikeReasonLabel("off_platform")).toBe("Contact or payment outside the platform");
    expect(strikeReasonLabel("new_reason")).toBe("New reason");
    expect(strikeReasonLabel(null)).toBe("Conduct warning");
  });
});

describe("crisis resources", () => {
  it("keeps only helplines with a dialable number and a name", () => {
    const r = normalizeResources({
      helplines: [
        {
          id: "a",
          name: { en: "Line A", hi: "ए" },
          number: "14416",
          hours: { en: "24x7", hi: "" },
        },
        { id: "b", name: { en: "Bad" }, number: "call me" },
        { id: "c", number: "112" },
      ],
      not_a_helpline: { en: "Not a helpline.", hi: "" },
    });
    expect(r?.helplines.map((h) => h.id)).toEqual(["a"]);
    expect(r?.not_a_helpline.en).toBe("Not a helpline.");
    expect(normalizeResources({ helplines: [] })).toBeNull();
    expect(normalizeResources(null)).toBeNull();
  });

  it("builds tel: links from digits only", () => {
    expect(telHref("14416")).toBe("tel:14416");
    expect(telHref("+91 98 765")).toBe("tel:+9198765");
  });
});
