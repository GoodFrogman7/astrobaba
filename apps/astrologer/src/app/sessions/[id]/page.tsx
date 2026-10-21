import type { SafetyResources, SessionView } from "@astro/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { OPAQUE_ID } from "@/lib/forward";
import { consolePage } from "@/lib/guard";
import { normalizeResources } from "@/lib/trust";
import { CallRoom } from "./CallRoom";
import { ChatRoom } from "./ChatRoom";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Consultation" };

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!OPAQUE_ID.test(id)) notFound();
  // No terms gate here: a consultation in progress is never cut off by a new terms version.
  const page = await consolePage(
    async () => {
      const [session, resources] = await Promise.all([
        api.get<SessionView>(`/v1/sessions/${encodeURIComponent(id)}`).catch((e: unknown) => {
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
          throw e;
        }),
        // Crisis helplines, ready before any `safety` event; the room retries if this fails.
        api
          .get<SafetyResources>("/v1/safety/resources")
          .then(normalizeResources)
          .catch(() => null),
      ]);
      return { session, resources };
    },
    { terms: false },
  );
  if (!page.live) return page.notice;
  const { session: s, resources } = page.data;
  if (!s) notFound();
  return s.kind === "call" ? (
    <CallRoom initial={s} resources={resources} />
  ) : (
    <ChatRoom initial={s} resources={resources} />
  );
}
