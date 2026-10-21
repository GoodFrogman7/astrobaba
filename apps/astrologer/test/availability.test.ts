import type { AvailabilitySlot } from "@astro/shared";
import { describe, expect, it } from "vitest";
import {
  activeSlot,
  addSlot,
  copyDay,
  fromMinutes,
  groupByDay,
  invalidSlotIndex,
  istClock,
  removeSlot,
  sameSchedule,
  timeOptions,
  toMinutes,
  updateSlot,
  validateSlots,
} from "../src/lib/availability";

const slot = (weekday: number, start: string, end: string) =>
  ({ weekday, start, end }) as AvailabilitySlot;

describe("time helpers", () => {
  it("parses HH:MM, allowing 24:00 only as the end of the day", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("09:45")).toBe(585);
    expect(toMinutes("24:00")).toBe(1440);
    expect(toMinutes("24:15")).toBeNull();
    expect(toMinutes("9:00")).toBeNull();
    expect(toMinutes("12:60")).toBeNull();
    expect(fromMinutes(585)).toBe("09:45");
    expect(fromMinutes(1440)).toBe("24:00");
  });

  it("offers 15-minute picker steps", () => {
    const starts = timeOptions("start");
    const ends = timeOptions("end");
    expect(starts).toHaveLength(96);
    expect(starts[0]).toBe("00:00");
    expect(starts.at(-1)).toBe("23:45");
    expect(ends[0]).toBe("00:15");
    expect(ends.at(-1)).toBe("24:00");
  });
});

describe("validation (mirrors the API)", () => {
  it("accepts a normal week, touching slots and an overnight shift as two slots", () => {
    const v = validateSlots([
      slot(0, "09:00", "13:00"),
      slot(0, "13:00", "17:00"),
      slot(0, "22:00", "24:00"),
      slot(1, "00:00", "02:00"),
    ]);
    expect(v).toEqual({ ok: true, issues: [], tooMany: null });
  });

  it("points at the slot: start ≥ end, off-step times, bad day, malformed", () => {
    const v = validateSlots([
      slot(0, "10:00", "09:00"),
      slot(1, "10:10", "11:00"),
      slot(7, "10:00", "11:00"),
      slot(2, "aa", "11:00"),
      slot(3, "24:00", "24:00"),
    ]);
    expect(v.ok).toBe(false);
    expect(v.issues.map((i) => i.index)).toEqual([0, 1, 2, 3, 4]);
    expect(v.issues[0]!.message).toMatch(/end must be after the start/);
    expect(v.issues[1]!.message).toMatch(/15-minute/);
    expect(v.issues[2]!.message).toMatch(/day/);
  });

  it("flags both overlapping slots on the same weekday only", () => {
    const v = validateSlots([
      slot(0, "09:00", "12:00"),
      slot(1, "10:00", "11:00"),
      slot(0, "11:45", "13:00"),
    ]);
    expect(v.issues.map((i) => i.index)).toEqual([0, 2]);
    expect(v.issues[0]!.message).toBe("Overlaps Monday 11:45–13:00.");
    expect(v.issues[1]!.message).toBe("Overlaps Monday 09:00–12:00.");
  });

  it("refuses more than 21 slots", () => {
    const many = Array.from({ length: 22 }, (_, i) =>
      slot(i % 7, fromMinutes(Math.floor(i / 7) * 60), fromMinutes(Math.floor(i / 7) * 60 + 30)),
    );
    const v = validateSlots(many);
    expect(v.issues).toEqual([]);
    expect(v.ok).toBe(false);
    expect(v.tooMany).toMatch(/At most 21.*Remove 1/);
  });
});

describe("editing", () => {
  it("adds 10:00–13:00 on an empty day, then the next free gap", () => {
    const a = addSlot([], 2)!;
    expect(a).toEqual([slot(2, "10:00", "13:00")]);
    const b = addSlot(a, 2)!;
    expect(b[1]).toEqual(slot(2, "13:00", "16:00"));
    const c = addSlot([slot(4, "10:00", "23:30")], 4)!;
    expect(c[1]).toEqual(slot(4, "23:30", "24:00"));
    // The only room left is before the first slot.
    const d = addSlot([slot(5, "06:00", "24:00")], 5)!;
    expect(d[1]).toEqual(slot(5, "00:00", "03:00"));
  });

  it("refuses to add to a full day or past the weekly limit", () => {
    expect(addSlot([slot(0, "00:00", "24:00")], 0)).toBeNull();
    const full = Array.from({ length: 21 }, (_, i) => slot(i % 7, "00:00", "00:15"));
    expect(addSlot(full, 3)).toBeNull();
  });

  it("updates and removes by index without touching other slots", () => {
    const s = [slot(0, "09:00", "10:00"), slot(1, "09:00", "10:00")];
    expect(updateSlot(s, 1, { end: "11:00" })).toEqual([
      slot(0, "09:00", "10:00"),
      slot(1, "09:00", "11:00"),
    ]);
    expect(removeSlot(s, 0)).toEqual([slot(1, "09:00", "10:00")]);
    expect(s).toHaveLength(2); // pure
  });

  it("copies a day onto other days, replacing their slots, within the limit", () => {
    const s = [slot(0, "09:00", "12:00"), slot(0, "14:00", "18:00"), slot(2, "08:00", "09:00")];
    const c = copyDay(s, 0, [0, 1, 2])!;
    expect(c.filter((x) => x.weekday === 2)).toEqual([
      slot(2, "09:00", "12:00"),
      slot(2, "14:00", "18:00"),
    ]);
    expect(c.filter((x) => x.weekday === 0)).toHaveLength(2);
    expect(c).toHaveLength(6);
    const four = [0, 1, 2, 3].map((h) => slot(0, fromMinutes(h * 60), fromMinutes(h * 60 + 30)));
    expect(copyDay(four, 0, [0, 1, 2, 3, 4, 5, 6])).toBeNull(); // 28 > 21
  });

  it("groups by day sorted by start, keeping indexes into the flat array", () => {
    const g = groupByDay([slot(1, "14:00", "15:00"), slot(1, "09:00", "10:00")]);
    expect(g).toHaveLength(7);
    expect(g[1]!.entries.map((e) => e.index)).toEqual([1, 0]);
    expect(g[0]!.entries).toEqual([]);
  });

  it("compares schedules regardless of order", () => {
    expect(
      sameSchedule(
        [slot(1, "09:00", "10:00"), slot(0, "09:00", "10:00")],
        [slot(0, "09:00", "10:00"), slot(1, "09:00", "10:00")],
      ),
    ).toBe(true);
    expect(sameSchedule([slot(0, "09:00", "10:00")], [slot(0, "09:00", "10:15")])).toBe(false);
  });
});

describe("the running slot, in IST", () => {
  // 2026-10-19 is a Monday. 03:45 UTC = 09:15 IST.
  const mon0915 = Date.parse("2026-10-19T03:45:00Z");

  it("reads the IST weekday and time", () => {
    expect(istClock(mon0915)).toEqual({ weekday: 0, minutes: 555 });
    // Sunday 20:00 UTC is Monday 01:30 IST.
    expect(istClock(Date.parse("2026-10-18T20:00:00Z"))).toEqual({ weekday: 0, minutes: 90 });
  });

  it("finds the slot that contains now (start inclusive, end exclusive)", () => {
    const s = [slot(0, "09:00", "09:15"), slot(0, "09:15", "10:00"), slot(1, "09:00", "10:00")];
    expect(activeSlot(s, mon0915)).toEqual(slot(0, "09:15", "10:00"));
    expect(activeSlot([slot(0, "09:00", "09:15")], mon0915)).toBeNull();
    expect(activeSlot([slot(6, "22:00", "24:00")], Date.parse("2026-10-25T18:00:00Z"))).toEqual(
      slot(6, "22:00", "24:00"),
    );
    expect(activeSlot([], mon0915)).toBeNull();
  });
});

describe("422 invalid_slots", () => {
  it("reads the slot index and bounds it", () => {
    expect(invalidSlotIndex(2, 3)).toBe(2);
    expect(invalidSlotIndex(0, 3)).toBe(0);
    expect(invalidSlotIndex(5, 3)).toBeNull();
    expect(invalidSlotIndex("1", 3)).toBeNull();
    expect(invalidSlotIndex(undefined, 3)).toBeNull();
  });
});
