import { describe, expect, it } from "vitest";
import { formatRupees, formatSignedRupees } from "../src/lib/money";
import {
  IDEMPOTENCY_KEY,
  keyAfter,
  newIdempotencyKey,
  parseOverride,
  parseReconDate,
  parseRefund,
  ruleLabel,
  txnLabel,
  yesterdayIst,
} from "../src/lib/money-admin";

describe("idempotency keys", () => {
  it("match the API's format and are unique", () => {
    const keys = new Set(Array.from({ length: 200 }, newIdempotencyKey));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(IDEMPOTENCY_KEY);
  });

  it("are kept while the outcome is unknown and replaced after a definite answer", () => {
    const k = newIdempotencyKey();
    expect(keyAfter(k, null)).toBe(k);
    expect(keyAfter(k, { ok: false, error: "API down", retryable: true })).toBe(k);
    expect(keyAfter(k, { ok: true })).not.toBe(k);
    expect(keyAfter(k, { ok: false, error: "amount too high" })).not.toBe(k);
  });
});

describe("refund form", () => {
  const good = {
    session_id: "ses_123",
    amount_rupees: "49.50",
    note: "Client could not hear",
    idempotency_key: "adm_0123456789abcdef",
  };

  it("parses rupees to integer paise", () => {
    expect(parseRefund(good)).toEqual({
      ok: true,
      value: {
        key: "adm_0123456789abcdef",
        body: { session_id: "ses_123", amount_paise: 4950, note: "Client could not hear" },
      },
    });
  });

  it.each([
    [{ session_id: "../x" }, "session id"],
    [{ amount_rupees: "0" }, "above zero"],
    [{ amount_rupees: "-5" }, "above zero"],
    [{ amount_rupees: "1.234" }, "above zero"],
    [{ note: "ok" }, "note"],
    [{ idempotency_key: "short" }, "expired"],
    [{ idempotency_key: "has space in it" }, "expired"],
  ])("rejects %j", (patch, msg) => {
    const r = parseRefund({ ...good, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
});

describe("free session override", () => {
  it("needs a known action and a note", () => {
    expect(parseOverride("u_1", { action: "allow", note: " checked ID " })).toEqual({
      ok: true,
      value: { user_id: "u_1", action: "allow", note: "checked ID" },
    });
    expect(parseOverride("u_1", { action: "delete", note: "x y z" }).ok).toBe(false);
    expect(parseOverride("u_1", { action: "block", note: "" }).ok).toBe(false);
    expect(parseOverride("u/1", { action: "block", note: "abc" }).ok).toBe(false);
  });
});

describe("reconciliation date", () => {
  const now = new Date("2026-10-21T20:00:00Z"); // 22 Oct 01:30 IST
  it("accepts real dates up to today in IST", () => {
    expect(parseReconDate("2026-10-22", now)).toEqual({ ok: true, value: "2026-10-22" });
    expect(parseReconDate("2026-10-23", now).ok).toBe(false);
    expect(parseReconDate("2026-02-30", now).ok).toBe(false);
    expect(parseReconDate("21/10/2026", now).ok).toBe(false);
  });
  it("defaults to yesterday in IST", () => {
    expect(yesterdayIst(now)).toBe("2026-10-21");
  });
});

describe("money display", () => {
  it("formats signed paise without floating point", () => {
    expect(formatRupees(-2550)).toBe("−₹25.50");
    expect(formatRupees(0)).toBe("₹0");
    expect(formatSignedRupees(2500)).toBe("+₹25");
    expect(formatSignedRupees(-5)).toBe("−₹0.05");
    expect(formatSignedRupees(0)).toBe("₹0");
  });

  it("labels rules and transaction kinds", () => {
    expect(ruleLabel("manual")).toBe("Manual (goodwill)");
    expect(ruleLabel("new_rule_x")).toBe("new rule x");
    expect(txnLabel("free_session_grant")).toBe("Free session");
  });
});
