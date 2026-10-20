import { describe, expect, it } from "vitest";
import { allFlags, flagEnabled } from "../src/flags";

describe("feature flags", () => {
  it("uses defaults from flags.json", () => {
    expect(flagEnabled("hindi_locale", {})).toBe(true);
    expect(flagEnabled("ai_assistant", {})).toBe(false);
  });

  it("lets FLAG_<NAME> override the default", () => {
    expect(flagEnabled("ai_assistant", { FLAG_AI_ASSISTANT: "true" })).toBe(true);
    expect(flagEnabled("hindi_locale", { FLAG_HINDI_LOCALE: "0" })).toBe(false);
    expect(flagEnabled("hindi_locale", { FLAG_HINDI_LOCALE: "maybe" })).toBe(true);
  });

  it("lists every flag", () => {
    expect(Object.keys(allFlags({})).sort()).toEqual([
      "ai_assistant",
      "first_free_session",
      "hindi_locale",
      "recharge_bonus_tiers",
    ]);
  });
});
