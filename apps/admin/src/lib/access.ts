import type { Me } from "./types";

export type Access = { kind: "anon" } | { kind: "forbidden"; me: Me } | { kind: "admin"; me: Me };

export function decideAccess(me: Me | null): Access {
  if (!me) return { kind: "anon" };
  return (me.roles ?? []).includes("admin") ? { kind: "admin", me } : { kind: "forbidden", me };
}

/**
 * Load page data only for admins: `load` is never called for anonymous or non-admin sessions,
 * so nothing protected is even requested from the API on their behalf.
 */
export async function withAdmin<T>(
  fetchMe: () => Promise<Me | null>,
  load: (me: Me) => Promise<T>,
): Promise<{ access: Access; data: T | null }> {
  const access = decideAccess(await fetchMe());
  if (access.kind !== "admin") return { access, data: null };
  return { access, data: await load(access.me) };
}
