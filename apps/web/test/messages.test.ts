import { describe, expect, it } from "vitest";
import enCore from "../messages/en.json" with { type: "json" };
import enTools from "../messages/en/tools.json" with { type: "json" };
import enAlmanac from "../messages/en/almanac.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiTools from "../messages/hi/tools.json" with { type: "json" };
import hiAlmanac from "../messages/hi/almanac.json" with { type: "json" };

const en = { ...enCore, ...enTools, ...enAlmanac };
const hi = { ...hiCore, ...hiTools, ...hiAlmanac };

it("area files never redefine a top-level namespace", () => {
  const all = [enCore, enTools, enAlmanac].flatMap((m) => Object.keys(m));
  expect(new Set(all).size).toBe(all.length);
});

function keys(obj: object, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === "object" && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

function leaves(obj: object): string[] {
  return Object.values(obj).flatMap((v) => (typeof v === "object" && v !== null ? leaves(v) : [v]));
}

describe("messages", () => {
  it("Hindi has exactly the same keys as English", () => {
    expect(keys(hi).sort()).toEqual(keys(en).sort());
  });

  it("Hindi strings are translated, not English copies", () => {
    const enLeaves = leaves(en);
    const copied = leaves(hi).filter(
      (s, i) => s === enLeaves[i] && /[a-z]{3}/i.test(s) && !s.includes("{"),
    );
    // "English" (the language switch label) is the only intentional Latin-script value.
    expect(copied.filter((s) => s !== "English")).toEqual([]);
  });

  it("meta descriptions are distinct and within 50–160 characters", () => {
    for (const m of [en.meta, hi.meta]) {
      expect(m.description.length).toBeGreaterThanOrEqual(50);
      expect(m.description.length).toBeLessThanOrEqual(160);
    }
    expect(en.meta.description).not.toBe(hi.meta.description);
  });
});
