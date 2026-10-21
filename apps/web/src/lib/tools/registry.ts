/**
 * The free tools (PLAN.md §5 Phase 2). One entry per tool; the generic /tools/[slug] page and
 * the hub render from this list. The birth chart tool is the /kundli page.
 * Pure data: safe to import from server and client code.
 */
export type ToolForm = "birth" | "numerology" | "dob";
export type ToolKind =
  | "sun-moon-ascendant"
  | "nakshatra"
  | "vimshottari-dasha"
  | "mangal-dosha"
  | "sade-sati"
  | "kaal-sarp-dosha"
  | "mulank"
  | "destiny-number"
  | "name-numerology";

export interface ToolDef {
  slug: ToolKind;
  contentKey: string;
  form: ToolForm;
}

export const TOOLS: ToolDef[] = [
  { slug: "sun-moon-ascendant", contentKey: "sun-moon-ascendant", form: "birth" },
  { slug: "nakshatra", contentKey: "nakshatra", form: "birth" },
  { slug: "vimshottari-dasha", contentKey: "vimshottari-dasha", form: "birth" },
  { slug: "mangal-dosha", contentKey: "mangal-dosha", form: "birth" },
  { slug: "sade-sati", contentKey: "sade-sati", form: "birth" },
  { slug: "kaal-sarp-dosha", contentKey: "kaal-sarp-dosha", form: "birth" },
  { slug: "mulank", contentKey: "mulank", form: "dob" },
  { slug: "destiny-number", contentKey: "destiny-number", form: "dob" },
  { slug: "name-numerology", contentKey: "name-numerology", form: "numerology" },
];

/** Every launch tool, including the birth chart (/kundli), for the hub page. */
export const HUB_ENTRIES: { key: string; href: string }[] = [
  { key: "kundli", href: "/kundli" },
  ...TOOLS.map((t) => ({ key: t.slug, href: `/tools/${t.slug}` })),
];

export function findTool(slug: string): ToolDef | undefined {
  return TOOLS.find((t) => t.slug === slug);
}
