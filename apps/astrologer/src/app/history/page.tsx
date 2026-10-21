import type { SessionView } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { api } from "@/lib/api";
import { endReasonText, formatIst, formatRate, formatRupees } from "@/lib/format";
import { consolePage } from "@/lib/guard";
import type { Page } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Session history" };

const STATUS: Record<string, string> = {
  queued: "Queued",
  requested: "Requested",
  accepted: "Accepted",
  active: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Did not start",
};

export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const sp = await searchParams;
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const page = await consolePage(() => {
    const params = new URLSearchParams({ role: "astrologer", limit: "25" });
    if (cursor) params.set("cursor", cursor);
    return api.get<Page<SessionView>>(`/v1/sessions?${params}`);
  });
  if (!page.live) return page.notice;
  const { data } = page;
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Session history</h1>
      <p className="mt-2 text-sm text-muted">
        Billed minutes and the amount charged to the client. Your share after commission is under{" "}
        <Link href="/earnings" className="underline">
          Earnings
        </Link>
        , and monthly statements under{" "}
        <Link href="/payouts" className="underline">
          Payouts
        </Link>
        .
      </p>
      {data.items.length === 0 ? (
        <p className="mt-8 text-muted">No sessions yet.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  When (IST)
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Client
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Type
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Rate
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Billed minutes
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Billed amount
                </th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={s.id} className="border-b border-border align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {formatIst(s.started_at ?? s.created_at)}
                  </td>
                  <td className="py-2 pr-4">{s.client_label}</td>
                  <td className="py-2 pr-4">{s.kind === "call" ? "Call" : "Chat"}</td>
                  <td className="py-2 pr-4">
                    {STATUS[s.status] ?? s.status}
                    {s.end_reason && (
                      <span className="block text-xs text-muted">
                        {endReasonText(s.end_reason, s.kind === "call" ? "call" : "chat")}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {s.is_free ? "Free" : formatRate(s.price_per_min_paise)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{s.billed_minutes}</td>
                  <td className="py-2 text-right tabular-nums">
                    {s.is_free ? "–" : formatRupees(s.billed_paise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-4 flex gap-4 text-sm">
        {cursor && (
          <Link href="/history" className="underline">
            First page
          </Link>
        )}
        {data.next_cursor && (
          <Link
            href={`/history?${new URLSearchParams({ cursor: data.next_cursor })}`}
            className="underline"
          >
            Next page
          </Link>
        )}
      </div>
    </main>
  );
}
