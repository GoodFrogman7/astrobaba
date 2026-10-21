import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import type { AdminReview, Page } from "@/lib/types";
import { hideReview, unhideReview } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reviews" };

const TABS = ["flagged", "hidden", "published"] as const;
type Tab = (typeof TABS)[number];

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const status: Tab = (TABS as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as Tab)
    : "flagged";
  const { access, data } = await adminPage(() => {
    const params = new URLSearchParams({ status, limit: "25" });
    if (sp.cursor) params.set("cursor", sp.cursor);
    return api.get<Page<AdminReview>>(`/v1/admin/reviews?${params}`);
  });
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Review moderation</h1>
      <nav aria-label="Review status" className="mt-4">
        <ul className="flex gap-1 text-sm">
          {TABS.map((t) => (
            <li key={t}>
              <Link
                href={`/reviews?status=${t}`}
                aria-current={t === status ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 ${t === status ? "bg-primary text-primary-fg" : "border border-border"}`}
              >
                {t[0]!.toUpperCase() + t.slice(1)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {data.items.length === 0 ? (
        <p className="mt-8 text-muted">No {status} reviews.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {data.items.map((r) => (
            <li key={r.id} className="rounded-md border border-border bg-surface p-4">
              <div className="flex flex-wrap justify-between gap-2 text-sm">
                <span>
                  <strong aria-label={`${r.rating} of 5`}>
                    {"★".repeat(r.rating)}
                    {"☆".repeat(5 - r.rating)}
                  </strong>{" "}
                  for{" "}
                  {r.astrologer ? (
                    <Link href={`/astrologers/${r.astrologer.id}`} className="underline">
                      {r.astrologer.display_name}
                    </Link>
                  ) : (
                    "a removed astrologer"
                  )}
                </span>
                <span className="text-muted">
                  {r.created_at.slice(0, 10)} · reports: {r.report_count}
                </span>
              </div>
              {r.held && (
                <p className="mt-2 text-sm text-danger">
                  Held automatically{r.auto_flag_reason ? `: ${r.auto_flag_reason}` : ""}
                </p>
              )}
              <p className="mt-2 whitespace-pre-line">{r.text}</p>
              {r.reply && (
                <p className="mt-2 border-l-2 border-border pl-3 text-sm text-muted">
                  Reply: {r.reply.text}
                </p>
              )}
              {r.moderation_note && (
                <p className="mt-2 text-sm text-muted">Moderation note: {r.moderation_note}</p>
              )}
              <div className="mt-3">
                {(r.status === "hidden" || r.held) && (
                  <ActionForm
                    action={unhideReview.bind(null, r.id)}
                    submitLabel={r.held ? "Publish" : "Publish again"}
                    confirm="Show this review publicly?"
                    className="mb-3"
                  />
                )}
                {r.status !== "hidden" && (
                  <ActionForm
                    action={hideReview.bind(null, r.id)}
                    submitLabel="Hide"
                    confirm="Hide this review from the public?"
                    destructive
                  >
                    <label className="block text-sm">
                      Reason
                      <input
                        name="reason"
                        required
                        minLength={3}
                        className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
                      />
                    </label>
                  </ActionForm>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.next_cursor && (
        <Link
          href={`/reviews?${new URLSearchParams({ status, cursor: data.next_cursor })}`}
          className="mt-4 inline-block text-sm underline"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
