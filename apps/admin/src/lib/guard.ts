import "server-only";

import { redirect } from "next/navigation";
import { withAdmin } from "./access";
import { fetchMe } from "./api";
import type { Me } from "./types";

/** Page guard: anonymous → /login; signed-in non-admins get `forbidden` and no data. */
export async function adminPage<T>(load: (me: Me) => Promise<T>) {
  const result = await withAdmin(fetchMe, load);
  if (result.access.kind === "anon") redirect("/login");
  return result;
}
