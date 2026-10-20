import { describe, expect, it } from "vitest";
import { AI_LABEL, DISCLAIMER } from "../src/disclaimer";
import { LOCALES } from "../src/locales";

describe("disclaimer", () => {
  it.each(LOCALES)("exists for %s", (locale) => {
    expect(DISCLAIMER[locale].length).toBeGreaterThan(20);
    expect(AI_LABEL[locale].length).toBeGreaterThan(0);
  });

  it("matches the plan's English wording exactly", () => {
    expect(DISCLAIMER.en).toBe(
      "For guidance and entertainment. Not medical, legal or financial advice.",
    );
  });
});
