import { describe, expect, it } from "vitest";
import {
  endReasonText,
  formatElapsed,
  formatIst,
  formatRate,
  formatRupees,
  formatWaiting,
  titleWithBadge,
} from "../src/lib/format";

describe("formatters", () => {
  it("formats paise as rupees for display only", () => {
    expect(formatRupees(2550)).toBe("₹25.50");
    expect(formatRupees(150000)).toBe("₹1,500");
    expect(formatRupees(5)).toBe("₹0.05");
    expect(formatRupees(-2500)).toBe("−₹25");
    expect(formatRate(2500)).toBe("₹25/min");
  });

  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(-5000)).toBe("0:00");
    expect(formatElapsed(65_000)).toBe("1:05");
    expect(formatElapsed(3_725_000)).toBe("1:02:05");
  });

  it("formats waiting time", () => {
    const t0 = "2026-10-21T10:00:00Z";
    const at = (s: number) => Date.parse(t0) + s * 1000;
    expect(formatWaiting(t0, at(2))).toBe("just now");
    expect(formatWaiting(t0, at(45))).toBe("45 s");
    expect(formatWaiting(t0, at(180))).toBe("3 min");
    expect(formatWaiting(t0, at(3900))).toBe("1 h 5 min");
    expect(formatWaiting("garbage", at(10))).toBe("just now");
  });

  it("shows times in IST", () => {
    expect(formatIst("2026-10-21T18:45:00Z")).toMatch(/22 Oct 2026.*12:15\s?am/i);
    expect(formatIst(null)).toBe("–");
  });

  it("badges the tab title with waiting requests", () => {
    expect(titleWithBadge("Console", 0)).toBe("Console");
    expect(titleWithBadge("Console", 2)).toBe("(2) Console");
  });

  it("explains end reasons without personal data", () => {
    expect(endReasonText("insufficient_funds")).toBe("The client's balance ran out.");
    expect(endReasonText(null)).toBe("The chat has ended.");
    expect(endReasonText("something_new")).toBe("The chat has ended.");
  });
});
