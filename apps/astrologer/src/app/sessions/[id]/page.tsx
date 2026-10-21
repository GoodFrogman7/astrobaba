import type { SessionView } from "@astro/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { StatusNotice } from "@/components/StatusNotice";
import { api, ApiError } from "@/lib/api";
import { SESSION_ID } from "@/lib/forward";
import { consolePage } from "@/lib/guard";
import { ChatRoom } from "./ChatRoom";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat" };

export default async function ChatPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!SESSION_ID.test(id)) notFound();
  const { access, data } = await consolePage(async () => {
    try {
      return await api.get<SessionView>(`/v1/sessions/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  });
  if (access.kind === "anon") return null;
  if (access.kind !== "live") return <StatusNotice access={access} />;
  if (!data) notFound();
  return <ChatRoom initial={data} />;
}
