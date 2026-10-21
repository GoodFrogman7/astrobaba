import type { Metadata } from "next";
import Link from "next/link";
import { LoadError } from "@/components/LoadError";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst } from "@/lib/money-admin";
import {
  asList,
  countsText,
  itemOutcome,
  itemTime,
  kindFilter,
  KIND_HELP,
  KIND_LABEL,
  MODERATION_KINDS,
  MODERATION_STATUSES,
  moderationStatusFilter,
  reasonCodes,
  reasonLabel,
  type ModerationItem,
  type ModerationKind,
  type ModerationStatus,
} from "@/lib/trust-admin";
import { actOnModeration } from "./actions";
import { ModerationActions } from "./ModerationActions";
import { RevealMessage } from "./RevealMessage";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Moderation" };

function href(kind: ModerationKind, status: ModerationStatus, cursor?: string) {
  const p = new URLSearchParams({ kind, status });
  if (cursor) p.set("cursor", cursor);
  return `/moderation?${p}`;
}

/**
 * Moderation queue (docs/api/trust.md §4): reason codes, counts, session ids and times. Chat
 * text is never loaded by default; a safety item's flagged message is revealed only on request.
 */
export default async function ModerationPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; status?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const kind = kindFilter(sp.kind);
  const status = moderationStatusFilter(sp.status);
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const { access, data } = await adminPage(() =>
    tryLoad(async () => {
      const params = new URLSearchParams({ kind, status });
      if (cursor) params.set("cursor", cursor);
      return asList<ModerationItem>(await api.get<unknown>(`/v1/admin/moderation?${params}`));
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Moderation</h1>
      <nav aria-label="Queue" className="mt-4 overflow-x-auto">
        <ul className="flex gap-1 text-sm">
          {MODERATION_KINDS.map((k) => (
            <li key={k}>
              <Link
                href={href(k, status)}
                prefetch={false}
                aria-current={k === kind ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 whitespace-nowrap ${
                  k === kind ? "bg-primary text-primary-fg" : "border border-border"
                }`}
              >
                {KIND_LABEL[k]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <nav aria-label="Status" className="mt-2">
        <ul className="flex gap-1 text-sm">
          {MODERATION_STATUSES.map((s) => (
            <li key={s}>
              <Link
                href={href(kind, s)}
                prefetch={false}
                aria-current={s === status ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1 ${
                  s === status ? "bg-accent text-accent-fg" : "border border-border"
                }`}
              >
                {s === "open" ? "Open" : "Closed"}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="mt-3 max-w-3xl text-sm text-muted">{KIND_HELP[kind]}</p>

      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-8 text-muted">
          No {status} {KIND_LABEL[kind].toLowerCase()}.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {data.value.items.map((item) => {
            const codes = reasonCodes(item);
            const outcome = itemOutcome(item);
            const isSafety = (item.kind ?? kind) === "safety";
            return (
              <li key={item.id} className="rounded-md border border-border bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">
                      {item.astrologer ? (
                        <Link
                          href={`/astrologers/${encodeURIComponent(item.astrologer.id)}`}
                          className="underline"
                        >
                          {item.astrologer.display_name || item.astrologer.id}
                        </Link>
                      ) : (
                        "No astrologer"
                      )}
                    </p>
                    <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="Reasons">
                      {codes.length === 0 ? (
                        <li className="text-sm text-muted">No reason code</li>
                      ) : (
                        codes.map((c) => (
                          <li
                            key={c}
                            className="rounded-sm border border-border px-1.5 py-0.5 text-xs"
                          >
                            {reasonLabel(c)}
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
                    <dt className="text-muted">When (IST)</dt>
                    <dd>{formatIst(itemTime(item))}</dd>
                    <dt className="text-muted">Counts</dt>
                    <dd className="tabular-nums">{countsText(item)}</dd>
                    <dt className="text-muted">Session</dt>
                    <dd className="font-mono text-xs">{item.session_id ?? "–"}</dd>
                    <dt className="text-muted">Item</dt>
                    <dd className="font-mono text-xs">{item.id}</dd>
                  </dl>
                </div>
                {outcome && <p className="mt-3 text-sm">{outcome}</p>}
                {isSafety && (
                  <div className="mt-3">
                    <RevealMessage id={item.id} />
                  </div>
                )}
                {status === "open" && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Act on this item
                    </summary>
                    <div className="mt-2">
                      <ModerationActions
                        action={actOnModeration.bind(null, item.id)}
                        canSuspend={!!item.astrologer}
                      />
                    </div>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data.ok && data.value.next_cursor && (
        <Link
          href={href(kind, status, data.value.next_cursor)}
          prefetch={false}
          className="mt-4 inline-block text-sm underline"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
