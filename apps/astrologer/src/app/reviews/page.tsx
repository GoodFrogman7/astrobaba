import type { Metadata } from "next";
import Link from "next/link";
import { StatusNotice } from "@/components/StatusNotice";
import { api, ApiError } from "@/lib/api";
import { formatIst } from "@/lib/format";
import { consolePage } from "@/lib/guard";
import { ratingLabel, reviewFilter, reviewStatus, stars } from "@/lib/reviews";
import type { Page, PortalReview } from "@/lib/types";
import { ReplyForm } from "./ReplyForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reviews" };

export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const filter = reviewFilter(sp.filter);
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const { access, data } = await consolePage(async () => {
    const q = new URLSearchParams({ filter, limit: "20" });
    if (cursor) q.set("cursor", cursor);
    try {
      return {
        ok: true as const,
        page: await api.get<Page<PortalReview>>(`/v1/astrologer/me/reviews?${q}`),
      };
    } catch (e) {
      if (e instanceof ApiError) return { ok: false as const, error: e.message || e.code };
      throw e;
    }
  });
  if (access.kind === "anon") return null;
  if (access.kind !== "live" || !data) {
    return access.kind === "live" ? null : <StatusNotice access={access} />;
  }
  const tabs = [
    { label: "All reviews", href: "/reviews", on: filter === "all" },
    { label: "Not replied yet", href: "/reviews?filter=unreplied", on: filter === "unreplied" },
  ];
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Reviews</h1>
      <p className="mt-2 text-sm text-muted">
        Reviews from your clients. You see the rating and text, never who wrote it. You can reply
        once to each review; a reply is public, is checked like reviews are, and cannot be edited
        afterwards.
      </p>
      <nav aria-label="Filter" className="mt-4">
        <ul className="flex gap-1 text-sm">
          {tabs.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={t.on ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 ${t.on ? "bg-primary text-primary-fg" : "border border-border"}`}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {!data.ok ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-danger px-4 py-3 text-sm text-danger"
        >
          Could not load reviews: {data.error}
        </p>
      ) : data.page.items.length === 0 ? (
        <p className="mt-8 text-muted">
          {filter === "unreplied" ? "Every review has a reply." : "No reviews yet."}
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {data.page.items.map((r) => {
            const st = reviewStatus(r.status);
            return (
              <li key={r.id} className="rounded-md border border-border bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p>
                    <span aria-hidden="true" className="text-accent">
                      {stars(r.rating)}
                    </span>
                    <span className="sr-only">{ratingLabel(r.rating)}</span>
                    <span className="ml-2 text-sm text-muted">
                      {r.author_label ?? "Verified client"}
                    </span>
                  </p>
                  <p className="text-sm text-muted">
                    {formatIst(r.created_at)} ·{" "}
                    <span className={st.held ? "font-medium text-fg" : ""}>{st.label}</span>
                  </p>
                </div>
                {st.note && <p className="mt-1 text-xs text-muted">{st.note}</p>}
                {r.text ? (
                  <p className="mt-2 whitespace-pre-wrap break-words">{r.text}</p>
                ) : (
                  <p className="mt-2 text-sm text-muted">Rating only, no text.</p>
                )}
                {r.reply ? (
                  <div className="mt-3 border-l-2 border-primary pl-3">
                    <p className="text-xs text-muted">Your reply · {formatIst(r.reply.at)}</p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">{r.reply.text}</p>
                  </div>
                ) : st.held ? (
                  <p className="mt-3 text-sm text-muted">
                    You can reply once a moderator has published this review.
                  </p>
                ) : (
                  <ReplyForm reviewId={r.id} />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 flex gap-4 text-sm">
        {cursor && (
          <Link
            href={filter === "all" ? "/reviews" : "/reviews?filter=unreplied"}
            className="underline"
          >
            First page
          </Link>
        )}
        {data.ok && data.page.next_cursor && (
          <Link
            href={`/reviews?${new URLSearchParams({
              ...(filter === "unreplied" ? { filter } : {}),
              cursor: data.page.next_cursor,
            })}`}
            className="underline"
          >
            Next page
          </Link>
        )}
      </div>
    </main>
  );
}
