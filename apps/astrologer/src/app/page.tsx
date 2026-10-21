import type { Availability } from "@astro/shared";
import { api } from "@/lib/api";
import { consolePage } from "@/lib/guard";
import { Console } from "./Console";

export const dynamic = "force-dynamic";

export default async function ConsoleHome() {
  const page = await consolePage(async () => {
    // Only for the gentle "your slot is running" reminder: the console works without it.
    try {
      return (await api.get<Availability>("/v1/astrologer/me/availability")).slots;
    } catch {
      return [];
    }
  });
  if (!page.live) return page.notice;
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Console</h1>
      <Console slots={page.data} />
    </main>
  );
}
