import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COLOR_TOKENS, RADIUS } from "../src/tokens";

const css = readFileSync(new URL("../tokens/tokens.css", import.meta.url), "utf8");

function block(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `selector ${selector} present`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("design tokens", () => {
  it("tokens.css mirrors tokens.ts in light, dark media query and data-theme=dark", () => {
    const blocks = {
      light: block(":root {"),
      darkMedia: block(':root:not([data-theme="light"])'),
      darkAttr: block(':root[data-theme="dark"]'),
    };
    for (const [name, value] of Object.entries(COLOR_TOKENS.light))
      expect(blocks.light).toContain(`--color-${name}: ${value};`);
    for (const [name, value] of Object.entries(COLOR_TOKENS.dark)) {
      expect(blocks.darkMedia).toContain(`--color-${name}: ${value};`);
      expect(blocks.darkAttr).toContain(`--color-${name}: ${value};`);
    }
    for (const [name, value] of Object.entries(RADIUS))
      expect(blocks.light).toContain(`--radius-${name}: ${value};`);
  });

  it.each(["light", "dark"] as const)("%s theme text pairs meet WCAG AA (4.5:1)", (theme) => {
    const t = COLOR_TOKENS[theme];
    const pairs: [string, string][] = [
      [t.fg, t.bg],
      [t.fg, t.surface],
      [t.muted, t.bg],
      [t.muted, t.surface],
      [t["primary-fg"], t.primary],
      [t["accent-fg"], t.accent],
      [t.primary, t.bg],
      [t.accent, t.surface],
      [t.danger, t.surface],
      [t.success, t.surface],
    ];
    for (const [fg, bg] of pairs)
      expect(contrast(fg, bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
  });
});
