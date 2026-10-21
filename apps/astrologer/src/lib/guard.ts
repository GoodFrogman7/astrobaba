import "server-only";

import { redirect } from "next/navigation";
import { withLiveAstrologer } from "./access";
import { fetchMe } from "./api";
import type { Me } from "./types";

/** Page guard: anonymous → /login; signed-in but not live → status notice and no data. */
export async function consolePage<T>(load: (me: Me) => Promise<T>) {
  const result = await withLiveAstrologer(fetchMe, load);
  if (result.access.kind === "anon") redirect("/login");
  return result;
}
