import { describe, expect, it } from "vitest";
import { calendarDate, formatInZone, istToday } from "../src/time";

describe("IST date source", () => {
  it("rolls over at 00:00 IST, i.e. 18:30 UTC the previous day", () => {
    expect(istToday(new Date("2026-03-14T18:29:59Z"))).toBe("2026-03-14");
    expect(istToday(new Date("2026-03-14T18:30:00Z"))).toBe("2026-03-15");
  });

  it("does not depend on the host time zone", () => {
    // Same instant, different zones: only the explicit zone matters.
    const instant = new Date("2026-01-01T20:00:00Z");
    expect(calendarDate(instant, "Asia/Kolkata")).toBe("2026-01-02");
    expect(calendarDate(instant, "America/New_York")).toBe("2026-01-01");
  });

  it("formats sunrise-style instants in the place's zone, not the browser's", () => {
    // 00:45 UTC is 06:15 in New Delhi.
    const s = formatInZone("2026-06-21T00:45:00Z", "Asia/Kolkata", "en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    expect(s).toBe("06:15");
  });

  it("rejects invalid instants instead of printing 'Invalid Date'", () => {
    expect(() => formatInZone("not-a-date", "Asia/Kolkata", "en")).toThrow(RangeError);
  });
});
