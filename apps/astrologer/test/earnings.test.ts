import { describe, expect, it } from "vitest";
import {
  barPercent,
  dayBars,
  daysInclusive,
  earningsHref,
  earningsQuery,
  EMPTY_TOTALS,
  formatDate,
  formatDeduction,
  formatMinutes,
  formatMonth,
  formatRange,
  isIsoDate,
  istMonthRange,
  payoutStatusText,
  resolvePeriod,
} from "../src/lib/earnings";

// 2026-10-31 20:00 UTC is already 1 November 01:30 in IST.
const lateOct31Utc = new Date("2026-10-31T20:00:00Z");
const midOct = new Date("2026-10-21T06:00:00Z");

describe("IST months", () => {
  it("uses the IST calendar, not UTC", () => {
    expect(istMonthRange(lateOct31Utc)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(istMonthRange(lateOct31Utc, -1)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });

  it("crosses years and knows month lengths", () => {
    const jan = new Date("2026-01-10T00:00:00Z");
    expect(istMonthRange(jan, -1)).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(istMonthRange(new Date("2028-03-05T00:00:00Z"), -1)).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
});

describe("period picker", () => {
  it("this month runs from the 1st to today (IST)", () => {
    expect(resolvePeriod({}, midOct)).toEqual({
      kind: "this_month",
      from: "2026-10-01",
      to: "2026-10-21",
      error: null,
    });
    expect(resolvePeriod({ period: "this_month" }, lateOct31Utc)).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-01",
    });
  });

  it("last month is the whole previous IST month", () => {
    expect(resolvePeriod({ period: "last_month" }, midOct)).toEqual({
      kind: "last_month",
      from: "2026-09-01",
      to: "2026-09-30",
      error: null,
    });
  });

  it("accepts a valid custom range of up to 366 days", () => {
    expect(
      resolvePeriod({ period: "custom", from: "2025-10-21", to: "2026-10-21" }, midOct),
    ).toEqual({ kind: "custom", from: "2025-10-21", to: "2026-10-21", error: null });
    expect(daysInclusive("2025-10-21", "2026-10-21")).toBe(366);
  });

  it("falls back to this month with a reason for a bad custom range", () => {
    const bad = (from: string, to: string) => resolvePeriod({ period: "custom", from, to }, midOct);
    expect(bad("", "2026-10-01")).toMatchObject({ kind: "this_month", error: /both/ });
    expect(bad("2026-02-30", "2026-03-01").error).toMatch(/both/);
    expect(bad("2026-10-10", "2026-10-01").error).toMatch(/on or before/);
    expect(bad("2026-11-01", "2026-11-05").error).toMatch(/future/);
    expect(bad("2025-10-20", "2026-10-21").error).toMatch(/366/);
  });

  it("builds the API query and page links", () => {
    const p = resolvePeriod({ period: "custom", from: "2026-09-01", to: "2026-09-15" }, midOct);
    expect(earningsQuery(p)).toBe("from=2026-09-01&to=2026-09-15&limit=25");
    expect(earningsQuery(p, "c_2")).toBe("from=2026-09-01&to=2026-09-15&limit=25&cursor=c_2");
    expect(earningsHref(p, "c_2")).toBe(
      "/earnings?period=custom&from=2026-09-01&to=2026-09-15&cursor=c_2",
    );
    expect(earningsHref(resolvePeriod({}, midOct))).toBe("/earnings?period=this_month");
  });
});

describe("formatting", () => {
  it("formats IST dates without shifting them", () => {
    expect(isIsoDate("2026-10-21")).toBe(true);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(formatDate("2026-10-01")).toBe("1 Oct 2026");
    expect(formatRange("2026-10-01", "2026-10-31")).toBe("1 Oct 2026 – 31 Oct 2026");
    expect(formatRange("2026-10-01", "2026-10-01")).toBe("1 Oct 2026");
    expect(formatMonth("2026-09")).toBe("September 2026");
    expect(formatMonth("bad")).toBe("bad");
  });

  it("formats minutes and deductions", () => {
    expect(formatMinutes(45)).toBe("45 min");
    expect(formatMinutes(60)).toBe("1 h");
    expect(formatMinutes(125)).toBe("2 h 5 min");
    expect(formatDeduction(12050)).toBe("−₹120.50");
    expect(formatDeduction(-500)).toBe("−₹5");
    expect(formatDeduction(0)).toBe("₹0");
  });

  it("scales day bars to the largest gross, sorted by date", () => {
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(1, 1000)).toBe(2);
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(5, 0)).toBe(0);
    const bars = dayBars([
      { ...EMPTY_TOTALS, date: "2026-10-02", gross_paise: 5000 },
      { ...EMPTY_TOTALS, date: "2026-10-01", gross_paise: 10000 },
    ]);
    expect(bars.map((b) => [b.date, b.percent])).toEqual([
      ["2026-10-01", 100],
      ["2026-10-02", 50],
    ]);
    expect(dayBars([])).toEqual([]);
  });

  it("explains payout statuses, including carried-forward amounts", () => {
    expect(payoutStatusText({ status: "paid", carried_forward_paise: 0 })).toMatch(/Paid/);
    expect(payoutStatusText({ status: "draft", carried_forward_paise: 0 })).toMatch(/can still/);
    expect(payoutStatusText({ status: "void", carried_forward_paise: 32000 })).toMatch(
      /₹320 was carried forward/,
    );
    expect(payoutStatusText({ status: "void", carried_forward_paise: 0 })).toMatch(/cancelled/);
  });
});
