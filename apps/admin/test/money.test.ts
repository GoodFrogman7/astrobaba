import { describe, expect, it } from "vitest";
import { checkPrice, formatRupees, rupeesToPaise } from "../src/lib/money";
import type { Tier } from "../src/lib/types";
import taxonomy from "../../../data/marketplace/taxonomy.json" with { type: "json" };

const rising = taxonomy.tiers.find((t) => t.id === "rising") as Tier;

describe("rupees to paise", () => {
  it.each([
    ["25", 2500],
    ["25.5", 2550],
    ["25.50", 2550],
    ["0.05", 5],
    [" 30 ", 3000],
    ["1234567.99", 123456799],
  ])("%s → %d", (input, paise) => expect(rupeesToPaise(input)).toBe(paise));

  it.each(["", "abc", "-5", "1.234", "1e3", "25,00", "0x10", "₹25"])("rejects %j", (input) =>
    expect(rupeesToPaise(input)).toBeNull(),
  );

  it("never goes through floating point (0.29 stays 29)", () => {
    expect(rupeesToPaise("0.29")).toBe(29);
    expect(rupeesToPaise("1.15")).toBe(115);
  });

  it("formats", () => {
    expect(formatRupees(2550)).toBe("₹25.50");
    expect(formatRupees(150000)).toBe("₹1,500");
  });
});

describe("tier bounds", () => {
  it("accepts the tier's own bounds and rejects outside them", () => {
    const lo = rising.min_price_per_min_paise;
    const hi = rising.max_price_per_min_paise;
    expect(checkPrice(String(lo / 100), rising)).toEqual({ ok: true, paise: lo });
    expect(checkPrice(String(hi / 100), rising)).toEqual({ ok: true, paise: hi });
    expect(checkPrice(((lo - 1) / 100).toFixed(2), rising).ok).toBe(false);
    expect(checkPrice(((hi + 1) / 100).toFixed(2), rising).ok).toBe(false);
  });

  it("needs a tier and a valid amount", () => {
    expect(checkPrice("20", undefined)).toEqual({ ok: false, error: "Choose a tier." });
    expect(checkPrice("twenty", rising).ok).toBe(false);
  });
});
