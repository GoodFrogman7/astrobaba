import { describe, expect, it } from "vitest";
import { approvePayload } from "../src/lib/horoscope";
import type { Sections } from "../src/lib/types";

const original: Sections = {
  overall: "Overall text.",
  love: "Love text.",
  career: "Career text.",
  money: "Money text.",
  health: "Health text.",
};

describe("horoscope approve payload", () => {
  it("sends only the reviewer when nothing changed", () => {
    expect(approvePayload(original, { ...original }, " Asha ")).toEqual({ reviewer: "Asha" });
    expect(approvePayload(original, {}, "Asha")).toEqual({ reviewer: "Asha" });
  });

  it("sends all five areas when one changed, with whitespace normalised", () => {
    const p = approvePayload(original, { ...original, love: "  Edited love text.\r\n" }, "Asha");
    expect(p.reviewer).toBe("Asha");
    expect(Object.keys(p.sections!)).toEqual(["overall", "love", "career", "money", "health"]);
    expect(p.sections!.love).toBe("Edited love text.");
    expect(p.sections!.overall).toBe("Overall text.");
  });

  it("ignores unexpected form fields", () => {
    const p = approvePayload(original, { ...original, extra: "x", money: "New money." }, "Asha");
    expect(p.sections).not.toHaveProperty("extra");
  });
});
