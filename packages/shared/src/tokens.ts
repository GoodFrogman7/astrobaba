/**
 * Design tokens: our own palette ("night indigo + terracotta on parchment").
 * tokens/tokens.css must mirror these values; test/tokens.test.ts enforces it.
 * Text/background pairs are chosen for WCAG AA contrast (checked in the same test).
 */
export const COLOR_TOKENS = {
  light: {
    bg: "#fbf8f3",
    surface: "#ffffff",
    fg: "#1b1e2e",
    muted: "#565b70",
    border: "#e4ded3",
    primary: "#2e3a8c",
    "primary-fg": "#ffffff",
    accent: "#a8401b",
    "accent-fg": "#ffffff",
    success: "#1f7a4d",
    danger: "#b3261e",
  },
  dark: {
    bg: "#0e1020",
    surface: "#171a2e",
    fg: "#eceaf4",
    muted: "#a3a7bd",
    border: "#2a2e48",
    primary: "#9da8f5",
    "primary-fg": "#0e1020",
    accent: "#f08a5d",
    "accent-fg": "#0e1020",
    success: "#5fd39a",
    danger: "#ff8a80",
  },
} as const;

export type ColorToken = keyof (typeof COLOR_TOKENS)["light"];

export const RADIUS = { sm: "0.375rem", md: "0.75rem", lg: "1.25rem" } as const;
