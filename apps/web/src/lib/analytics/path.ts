import schema from "@astro/shared/analytics/events.json";

/**
 * page_view paths (docs/api/growth.md §1.1): the URL path only, without the query string or
 * fragment, and without the /hi locale prefix (the locale is its own field). Segments that are
 * UUIDs become `_id` so no record id reaches analytics. A path that does not match the schema's
 * `path` type (packages/shared/analytics/events.json) is skipped: null.
 */
/** The schema's own pattern ("...: ^/[a-z0-9/_-]{0,199}$"), so the two cannot drift apart. */
const SPEC = schema.propertyTypes.path;
export const PATH_RE = new RegExp(SPEC.slice(SPEC.indexOf("^")));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizePath(raw: string, locales: readonly string[] = ["hi"]): string | null {
  const path = raw.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/")) return null;
  const segments = path.split("/").filter(Boolean);
  if (segments.length && locales.includes(segments[0] ?? "")) segments.shift();
  const out = `/${segments.map((s) => (UUID_RE.test(s) ? "_id" : s)).join("/")}`;
  return PATH_RE.test(out) ? out : null;
}
