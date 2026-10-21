import {
  ACCOUNT_STEPS,
  TRAFFIC_SOURCES,
  VISITOR_STEPS,
  type BreakdownRow,
  type FunnelStep,
  type FunnelStepKey,
  type FunnelWeek,
  type GrowthFunnel,
} from "@astro/shared";
import type { Metadata } from "next";
import { LoadError } from "@/components/LoadError";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import {
  STEP_LABEL,
  TARGET_CLASS_LABEL,
  barWidth,
  classifyRate,
  formatDay,
  formatRate,
  formatTarget,
  funnelApiPath,
  parseFunnelQuery,
} from "@/lib/growth-admin";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst } from "@/lib/money-admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Growth funnel" };

const MARK = { below: "▼", within: "●", above: "▲" } as const;
const MARK_CLASS = { below: "text-danger", within: "text-success", above: "text-success" } as const;

const th = "py-2 pr-4 font-medium";
const num = "py-2 pr-4 text-right tabular-nums";

function FunnelTable({ caption, steps }: { caption: string; steps: FunnelStep[] }) {
  const first = steps[0]?.count ?? 0;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-muted">
          <tr>
            <th scope="col" className={th}>
              Step
            </th>
            <th scope="col" className={`${th} w-1/3`}>
              Count (strict)
            </th>
            <th scope="col" className={`${th} text-right`}>
              Reached
            </th>
            <th scope="col" className={`${th} text-right`}>
              Rate from previous
            </th>
            <th scope="col" className={`${th} text-right`}>
              Target
            </th>
            <th scope="col" className={th}>
              Against target
            </th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => {
            const cls = classifyRate(s.rate, s.target);
            return (
              <tr key={s.key} className="border-b border-border align-middle">
                <th scope="row" className="py-2 pr-4 font-medium">
                  {STEP_LABEL[s.key] ?? s.key}
                </th>
                <td className="py-2 pr-4">
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-right tabular-nums">{s.count}</span>
                    <span aria-hidden="true" className="block h-3 flex-1 rounded-sm bg-bg">
                      <span
                        className="block h-3 rounded-sm bg-primary"
                        style={{ width: `${barWidth(s.count, first)}%` }}
                      />
                    </span>
                  </div>
                </td>
                <td className={num}>{s.reached}</td>
                <td className={num}>{formatRate(s.rate)}</td>
                <td className={num}>{formatTarget(s.target)}</td>
                <td className="py-2 pr-4">
                  {cls ? (
                    <span>
                      <span aria-hidden="true" className={`mr-1 ${MARK_CLASS[cls]}`}>
                        {MARK[cls]}
                      </span>
                      {TARGET_CLASS_LABEL[cls]}
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WeeksTable({
  caption,
  weeks,
  keys,
}: {
  caption: string;
  weeks: FunnelWeek[];
  keys: readonly FunnelStepKey[];
}) {
  if (weeks.length === 0) return <p className="mt-3 text-sm text-muted">No weekly cohorts.</p>;
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-muted">
          <tr>
            <th scope="col" className={th}>
              Week starting (Mon, IST)
            </th>
            {keys.map((k) => (
              <th key={k} scope="col" className={`${th} text-right`}>
                {STEP_LABEL[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.week_start} className="border-b border-border">
              <th scope="row" className="py-2 pr-4 font-normal whitespace-nowrap">
                {formatDay(w.week_start)}
              </th>
              {keys.map((k) => (
                <td key={k} className={num}>
                  {w.counts[k] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: BreakdownRow[] }) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No rows.</p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className={th}>
                  Key
                </th>
                <th scope="col" className={`${th} text-right`}>
                  Visits
                </th>
                <th scope="col" className={`${th} text-right`}>
                  OTP
                </th>
                <th scope="col" className={`${th} text-right`}>
                  First recharge
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border">
                  <th scope="row" className="py-2 pr-4 font-normal break-all">
                    {r.key === "other" ? "Other (merged)" : r.key}
                  </th>
                  <td className={num}>{r.visit}</td>
                  <td className={num}>{r.otp}</td>
                  <td className={num}>{r.first_recharge}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Funnel dashboard (growth.md §1.3). Filters are GET parameters so the URL can be shared. */
export default async function GrowthPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { query, problems } = parseFunnelQuery(await searchParams);
  const { access, data } = await adminPage(() =>
    tryLoad(() => api.get<GrowthFunnel>(funnelApiPath(query))),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const f = data.ok ? data.value : null;
  const visitorCohort = f?.visitor.steps[0]?.count ?? 0;
  const accountCohort = f?.account.steps[0]?.count ?? 0;
  const control = "mt-1 block rounded-sm border border-border bg-bg px-2 py-1";

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Growth funnel</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        First-party analytics only. Dates are IST. Targets are assumptions to validate, not facts.
        Locale and source filter the visitor funnel by its first page view.
      </p>

      <form method="get" action="/growth" className="mt-4 flex flex-wrap items-end gap-3 text-sm">
        <label>
          From
          <input type="date" name="from" defaultValue={query.from} className={control} />
        </label>
        <label>
          To
          <input type="date" name="to" defaultValue={query.to} className={control} />
        </label>
        <label>
          Window (days)
          <input
            type="number"
            name="window_days"
            min={1}
            max={90}
            defaultValue={query.window_days}
            className={`${control} w-24`}
          />
        </label>
        <label>
          Locale
          <select name="locale" defaultValue={query.locale} className={control}>
            <option value="all">All</option>
            <option value="en">English</option>
            <option value="hi">Hindi</option>
          </select>
        </label>
        <label>
          Source
          <select name="source" defaultValue={query.source} className={control}>
            <option value="all">All</option>
            {TRAFFIC_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-sm bg-primary px-3 py-1.5 text-primary-fg">Apply</button>
      </form>
      {problems.length > 0 && (
        <ul role="alert" className="mt-3 list-disc pl-5 text-sm text-danger">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      {!data.ok ? (
        <LoadError error={data.error} />
      ) : (
        f && (
          <>
            <p className="mt-4 text-xs text-muted">
              {formatDay(f.from)} to {formatDay(f.to)} · steps counted within {f.window_days} days ·
              generated {formatIst(f.generated_at)} IST
            </p>

            <section aria-labelledby="visitor-h" className="mt-8">
              <h2 id="visitor-h" className="text-lg font-semibold">
                Visitor funnel
              </h2>
              {visitorCohort === 0 ? (
                <p className="mt-3 text-muted">
                  No visitors had their first page view in this range with these filters.
                </p>
              ) : (
                <>
                  <FunnelTable caption="Visitor funnel" steps={f.visitor.steps} />
                  <h3 className="mt-6 font-medium">Weekly cohorts</h3>
                  <WeeksTable
                    caption="Visitor funnel by weekly cohort"
                    weeks={f.visitor.weeks}
                    keys={VISITOR_STEPS}
                  />
                  <h3 className="mt-6 font-medium">Breakdowns (top 10)</h3>
                  <div className="mt-2 grid gap-6 lg:grid-cols-3">
                    <BreakdownTable title="By source" rows={f.visitor.by_source} />
                    <BreakdownTable title="By tool" rows={f.visitor.by_tool} />
                    <BreakdownTable title="By landing page" rows={f.visitor.by_landing} />
                  </div>
                </>
              )}
            </section>

            <section aria-labelledby="account-h" className="mt-10">
              <h2 id="account-h" className="text-lg font-semibold">
                Account funnel
              </h2>
              <p className="mt-1 text-sm text-muted">
                Every account created in the range, measured from account creation.
              </p>
              {accountCohort === 0 ? (
                <p className="mt-3 text-muted">No accounts were created in this range.</p>
              ) : (
                <>
                  <FunnelTable caption="Account funnel" steps={f.account.steps} />
                  <h3 className="mt-6 font-medium">Weekly cohorts</h3>
                  <WeeksTable
                    caption="Account funnel by weekly cohort"
                    weeks={f.account.weeks}
                    keys={ACCOUNT_STEPS}
                  />
                </>
              )}
            </section>

            {f.notes.length > 0 && (
              <section aria-labelledby="notes-h" className="mt-10">
                <h2 id="notes-h" className="text-lg font-semibold">
                  Notes
                </h2>
                <ul className="mt-2 list-disc pl-5 text-sm text-muted">
                  {f.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )
      )}
    </main>
  );
}
