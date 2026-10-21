import { CONTENT_KINDS, CONTENT_STATUSES, type AlmanacDate, type ContentItem } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { LoadError } from "@/components/LoadError";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import {
  CONTENT_KIND_LABEL,
  CONTENT_LOCALE_LABEL,
  CONTENT_STATUS_LABEL,
  almanacLabel,
  almanacTitle,
  formatDay,
  groupByWeek,
  parseContentQuery,
} from "@/lib/growth-admin";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { deleteContentItem } from "./actions";
import { ContentForm } from "./ContentForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Content calendar" };

type SP = Record<string, string | string[] | undefined>;
type Loaded<T> = Awaited<ReturnType<typeof tryLoad<T>>>;

function prefillHref(d: AlmanacDate, base: { from: string; to: string }) {
  const p = new URLSearchParams({
    from: base.from,
    to: base.to,
    new_date: d.date,
    new_title: almanacTitle(d),
  });
  return `/content?${p}#new-item`;
}

function AlmanacPanel({
  result,
  base,
}: {
  result: Loaded<{ items: AlmanacDate[] }>;
  base: { from: string; to: string };
}) {
  return (
    <aside aria-labelledby="almanac-h" className="rounded-md border border-border bg-surface p-4">
      <h2 id="almanac-h" className="text-lg font-semibold">
        Dates to plan around
      </h2>
      <p className="mt-1 text-xs text-muted">
        Next 60 days, computed by the engine for New Delhi. Tithis are the tithi at sunrise and Sun
        signs are sidereal. These are not festival observance dates; check those separately.
      </p>
      {!result.ok ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          {result.status === 503 && result.code === "engine_unavailable"
            ? "Engine unavailable. Dates cannot be computed right now."
            : `Could not load dates: ${result.error}`}
        </p>
      ) : result.value.items.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No dates in the next 60 days.</p>
      ) : (
        <ul className="mt-3 space-y-3 text-sm">
          {result.value.items.map((d) => (
            <li key={`${d.date}-${d.kind}`} className="border-b border-border pb-2">
              <span className="block font-medium">{formatDay(d.date)}</span>
              <span className="block">{almanacLabel(d)}</span>
              <Link
                href={prefillHref(d, base)}
                prefetch={false}
                className="mt-1 inline-block rounded-sm border border-border px-2 py-0.5 text-xs"
              >
                Plan content for this date
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}

function ItemCard({ item }: { item: ContentItem }) {
  return (
    <li className="rounded-md border border-border bg-surface p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="font-medium break-words">{item.title}</h4>
        <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs">
          {CONTENT_STATUS_LABEL[item.status] ?? item.status}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        {CONTENT_KIND_LABEL[item.kind] ?? item.kind} ·{" "}
        {CONTENT_LOCALE_LABEL[item.locale] ?? item.locale}
        {" · "}
        {item.due_date ? `due ${formatDay(item.due_date)}` : "no due date"}
      </p>
      {item.url && (
        <p className="mt-1 text-sm break-all">
          {item.url.startsWith("/") ? (
            <span className="font-mono text-xs">{item.url}</span>
          ) : (
            <a href={item.url} rel="noopener noreferrer" target="_blank" className="underline">
              {item.url}
            </a>
          )}
        </p>
      )}
      {item.notes && <p className="mt-1 text-sm whitespace-pre-wrap break-words">{item.notes}</p>}
      <details className="mt-2">
        <summary className="cursor-pointer text-sm underline">Edit</summary>
        <div className="mt-3">
          <ContentForm item={item} idPrefix={`edit-${item.id}`} />
        </div>
      </details>
      <div className="mt-2">
        <ActionForm
          action={deleteContentItem.bind(null, item.id)}
          submitLabel="Delete"
          confirm="Delete this item?"
          destructive
        />
      </div>
    </li>
  );
}

/** Content calendar (growth.md §4) with engine-computed dates beside it. */
export default async function ContentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const q = parseContentQuery(sp);
  const { access, data } = await adminPage(async () => {
    const params = new URLSearchParams({ from: q.from, to: q.to });
    if (q.status) params.set("status", q.status);
    if (q.kind) params.set("kind", q.kind);
    const [items, almanac] = await Promise.all([
      tryLoad(() => api.get<{ items: ContentItem[] }>(`/v1/admin/content-items?${params}`)),
      tryLoad(() => api.get<{ items: AlmanacDate[] }>("/v1/admin/growth/almanac-dates?days=60")),
    ]);
    return { items, almanac };
  });
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const control = "mt-1 block rounded-sm border border-border bg-bg px-2 py-1";

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Content calendar</h1>
      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="min-w-0">
          <form method="get" action="/content" className="flex flex-wrap items-end gap-3 text-sm">
            <label>
              From
              <input type="date" name="from" defaultValue={q.from} className={control} />
            </label>
            <label>
              To
              <input type="date" name="to" defaultValue={q.to} className={control} />
            </label>
            <label>
              Status
              <select name="status" defaultValue={q.status ?? ""} className={control}>
                <option value="">All</option>
                {CONTENT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {CONTENT_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kind
              <select name="kind" defaultValue={q.kind ?? ""} className={control}>
                <option value="">All</option>
                {CONTENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CONTENT_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <button className="rounded-sm bg-primary px-3 py-1.5 text-primary-fg">Apply</button>
          </form>
          {q.problem && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {q.problem}
            </p>
          )}

          <section
            id="new-item"
            aria-labelledby="new-h"
            className="mt-6 rounded-md border border-border bg-surface p-4"
          >
            <h2 id="new-h" className="mb-3 font-semibold">
              New item
            </h2>
            <ContentForm
              key={`${q.prefill.due_date}|${q.prefill.title}`}
              initial={q.prefill}
              idPrefix="new"
            />
          </section>

          <section aria-labelledby="items-h" className="mt-8">
            <h2 id="items-h" className="text-lg font-semibold">
              {formatDay(q.from)} to {formatDay(q.to)}
            </h2>
            {!data.items.ok ? (
              <LoadError error={data.items.error} />
            ) : data.items.value.items.length === 0 ? (
              <p className="mt-3 text-muted">Nothing planned in this range.</p>
            ) : (
              groupByWeek(data.items.value.items).map((g) => (
                <section
                  key={g.week ?? "none"}
                  aria-label={g.week ? `Week of ${g.week}` : "No due date"}
                  className="mt-6"
                >
                  <h3 className="font-medium">
                    {g.week ? `Week of ${formatDay(g.week)}` : "No due date"}
                  </h3>
                  <ul className="mt-2 space-y-3">
                    {g.items.map((it) => (
                      <ItemCard key={it.id} item={it} />
                    ))}
                  </ul>
                </section>
              ))
            )}
          </section>
        </div>
        <AlmanacPanel result={data.almanac} base={q} />
      </div>
    </main>
  );
}
