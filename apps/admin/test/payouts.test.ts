import { describe, expect, it } from "vitest";
import {
  allowedActions,
  astrologerName,
  formatPeriod,
  istMonth,
  markPaidConsequence,
  parseGeneratePeriod,
  parseMarkPaid,
  parseVoidNote,
  payoutErrorText,
  periodFilter,
  previousIstMonth,
  statusFilter,
  statusLabel,
  sumPayouts,
} from "../src/lib/payouts";
import type { AdminPayout } from "../src/lib/types";

// 31 Oct 2026 20:00 UTC is 1 Nov 2026 01:30 in IST.
const nov1Ist = new Date("2026-10-31T20:00:00Z");
const midOct = new Date("2026-10-21T06:00:00Z");

function payout(over: Partial<AdminPayout> = {}): AdminPayout {
  return {
    id: "po_1",
    period: "2026-09",
    status: "draft",
    gross_paise: 100000,
    commission_paise: 30000,
    refunds_paise: 5000,
    net_paise: 65000,
    carried_forward_paise: 0,
    sessions: 12,
    minutes: 140,
    generated_at: "2026-10-01T00:05:00Z",
    approved_at: null,
    paid_at: null,
    reference: null,
    astrologer: { id: "a_1", display_name: "Demo Astrologer 01" },
    ...over,
  };
}

describe("periods (IST months)", () => {
  it("uses the IST calendar", () => {
    expect(istMonth(nov1Ist)).toBe("2026-11");
    expect(previousIstMonth(nov1Ist)).toBe("2026-10");
    expect(previousIstMonth(new Date("2026-01-15T00:00:00Z"))).toBe("2025-12");
  });

  it("reads the period filter, defaulting to last month", () => {
    expect(periodFilter("2026-07", midOct)).toBe("2026-07");
    expect(periodFilter("2026-13", midOct)).toBe("2026-09");
    expect(periodFilter(undefined, midOct)).toBe("2026-09");
  });

  it("generates only for months that have ended", () => {
    expect(parseGeneratePeriod("2026-09", midOct)).toEqual({ ok: true, value: "2026-09" });
    expect(parseGeneratePeriod("2026-10", midOct).ok).toBe(false);
    expect(parseGeneratePeriod("2027-01", midOct).ok).toBe(false);
    expect(parseGeneratePeriod("2026-9", midOct).ok).toBe(false);
    // On 1 Nov IST, October is closed even though it is still 31 Oct in UTC.
    expect(parseGeneratePeriod("2026-10", nov1Ist)).toEqual({ ok: true, value: "2026-10" });
  });

  it("formats a period", () => {
    expect(formatPeriod("2026-09")).toBe("September 2026");
    expect(formatPeriod("x")).toBe("x");
  });
});

describe("form parsing", () => {
  it("accepts a bank reference and a paid-on date that is not in the future", () => {
    expect(
      parseMarkPaid({ reference: " UTIBR52026100100123 ", paid_on: "2026-10-20" }, midOct),
    ).toEqual({ ok: true, value: { reference: "UTIBR52026100100123", paid_on: "2026-10-20" } });
  });

  it("refuses bad references and dates", () => {
    const p = (reference: string, paid_on: string) => parseMarkPaid({ reference, paid_on }, midOct);
    expect(p("", "2026-10-20").ok).toBe(false);
    expect(p("ab", "2026-10-20").ok).toBe(false);
    expect(p("UTR 123 456", "2026-10-20").ok).toBe(false);
    expect(p("UTR123456", "2026-02-30").ok).toBe(false);
    expect(p("UTR123456", "").ok).toBe(false);
    const future = p("UTR123456", "2026-10-22");
    expect(future).toEqual({ ok: false, error: "The paid-on date cannot be in the future." });
  });

  it("requires a void note", () => {
    expect(parseVoidNote("  dup  ").ok).toBe(false);
    expect(parseVoidNote("Duplicate statement")).toEqual({
      ok: true,
      value: { note: "Duplicate statement" },
    });
    expect(parseVoidNote("x".repeat(501)).ok).toBe(false);
  });

  it("reads the status filter", () => {
    expect(statusFilter("approved")).toBe("approved");
    expect(statusFilter("deleted")).toBeNull();
    expect(statusFilter(undefined)).toBeNull();
  });
});

describe("display", () => {
  it("explains errors in plain words, falling back to the API message", () => {
    expect(payoutErrorText("exceeds_payable", "x")).toMatch(/more than the astrologer's payable/);
    expect(payoutErrorText("exceeds_payable", "x")).toMatch(/Nothing was posted/);
    expect(payoutErrorText("invalid_transition", "x")).toMatch(/Reload/);
    expect(payoutErrorText("period_in_future", "Too early")).toBe(
      "That month can't be used: Too early",
    );
    expect(payoutErrorText("something_else", "Server says")).toBeUndefined();
  });

  it("allows only the next step for each status", () => {
    expect(allowedActions("draft")).toEqual({ approve: true, pay: false, void: true });
    expect(allowedActions("approved")).toEqual({ approve: false, pay: true, void: true });
    expect(allowedActions("paid")).toEqual({ approve: false, pay: false, void: false });
    expect(allowedActions("void")).toEqual({ approve: false, pay: false, void: false });
    expect(statusLabel("approved")).toBe("Approved");
    expect(statusLabel("weird")).toBe("weird");
  });

  it("totals the rows shown, with void rows excluded from what would be paid", () => {
    const t = sumPayouts([
      payout(),
      payout({ id: "po_2", status: "void", net_paise: 20000, carried_forward_paise: 20000 }),
    ]);
    expect(t).toEqual({
      count: 2,
      gross_paise: 200000,
      commission_paise: 60000,
      refunds_paise: 10000,
      net_paise: 85000,
      carried_forward_paise: 20000,
      payable_net_paise: 65000,
    });
    expect(sumPayouts([]).count).toBe(0);
  });

  it("spells out the ledger posting of mark-paid", () => {
    expect(markPaidConsequence(payout())).toBe(
      "This posts ledger transaction payout:po_1 for ₹650: debit astrologer:a_1:payable, credit bank:payouts. It is recorded in the audit log under your account and cannot be undone from here.",
    );
    expect(astrologerName(payout({ astrologer: null, astrologer_id: "a_9" }))).toBe("a_9");
  });
});
