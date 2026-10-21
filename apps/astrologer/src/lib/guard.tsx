import "server-only";

import { redirect } from "next/navigation";
import type { ReactElement } from "react";
import { StatusNotice } from "@/components/StatusNotice";
import { withLiveAstrologer } from "./access";
import { fetchMe } from "./api";
import type { Me } from "./types";

/** Page guard: anonymous → /login; signed-in but not live → status notice and no data. */
export async function consolePage<T>(
  load: (me: Me) => Promise<T>,
): Promise<{ live: true; data: T } | { live: false; notice: ReactElement }> {
  const { access, data } = await withLiveAstrologer(fetchMe, load);
  if (access.kind === "anon") redirect("/login");
  if (access.kind !== "live") return { live: false, notice: <StatusNotice access={access} /> };
  return { live: true, data: data as T };
}
