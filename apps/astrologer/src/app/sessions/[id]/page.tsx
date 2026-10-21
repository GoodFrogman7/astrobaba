import type { SessionView } from "@astro/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { OPAQUE_ID } from "@/lib/forward";
import { consolePage } from "@/lib/guard";
import { CallRoom } from "./CallRoom";
import { ChatRoom } from "./ChatRoom";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Consultation" };

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!OPAQUE_ID.test(id)) notFound();
  const page = await consolePage(async () => {
    try {
      return await api.get<SessionView>(`/v1/sessions/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  });
  if (!page.live) return page.notice;
  const s = page.data;
  if (!s) notFound();
  return s.kind === "call" ? <CallRoom initial={s} /> : <ChatRoom initial={s} />;
}
