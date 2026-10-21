import type { Helpline, SafetyResources } from "@astro/shared";
import helplinesFile from "../../../../../data/safety/helplines.json" with { type: "json" };

/**
 * Crisis resources (docs/api/trust.md §3): only the helplines in data/safety/helplines.json,
 * which the API serves at GET /v1/safety/resources. Nothing here adds or edits a number.
 */
const NUMBER = /^[0-9]{2,15}$/;

const localized = (v: unknown): { en: string; hi: string } | null => {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return typeof o.en === "string" && typeof o.hi === "string" ? { en: o.en, hi: o.hi } : null;
};

export function normalizeResources(raw: unknown): SafetyResources | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const notAHelpline = localized(r.not_a_helpline);
  if (!notAHelpline || !Array.isArray(r.helplines)) return null;
  const helplines: Helpline[] = [];
  for (const h of r.helplines as Record<string, unknown>[]) {
    const name = localized(h?.name);
    const hours = localized(h?.hours);
    if (!h || typeof h.id !== "string" || typeof h.number !== "string" || !name || !hours) continue;
    if (!NUMBER.test(h.number)) continue;
    helplines.push({
      id: h.id,
      name,
      number: h.number,
      hours,
      official_site:
        typeof h.official_site === "string" && /^https:\/\//.test(h.official_site)
          ? h.official_site
          : "",
    });
  }
  return helplines.length ? { helplines, not_a_helpline: notAHelpline } : null;
}

/** The verified file, bundled: what the crisis panel shows until (or if) the API answers. */
export const BUNDLED_RESOURCES: SafetyResources = normalizeResources(helplinesFile)!;

/** `tel:` link for a helpline number (digits only by construction). */
export function telHref(number: string): string {
  return `tel:${number.replace(/[^0-9]/g, "")}`;
}

let cached: Promise<SafetyResources> | null = null;

/** Browser: GET /api/safety/resources once per page; the bundled file if it fails. */
export function loadResourcesClient(
  fetcher: typeof fetch = (...a) => fetch(...a),
): Promise<SafetyResources> {
  cached ??= fetcher("/api/safety/resources", { cache: "no-store" })
    .then(async (res) => (res.ok ? normalizeResources(await res.json()) : null))
    .catch(() => null)
    .then((r) => r ?? BUNDLED_RESOURCES);
  return cached;
}

export function resetResourcesCache(): void {
  cached = null;
}
