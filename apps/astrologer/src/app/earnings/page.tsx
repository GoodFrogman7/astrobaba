import type { Earnings } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { StatusNotice } from "@/components/StatusNotice";
import { api, ApiError } from "@/lib/api";
import {
  dayBars,
  earningsHref,
  earningsQuery,
  formatDate,
  formatDeduction,
  formatMinutes,
  formatMonth,
  formatRange,
  resolvePeriod,
  type PeriodKind,
} from "@/lib/earnings";
import { formatIst, formatRupees } from "@/lib/format";
import { consolePage } from "@/lib/guard";
import type { Balance } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Earnings" };

type Loaded<T> = { ok: true; value: T } | { ok: false; error: string };

async function load<T>(path: string): Promise<Loaded<T>> {
  try {
    return { ok: true, value: await api.get<T>(path) };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message || e.code };
    throw e;
  }
}

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.slice(0, 200) : "");

const PERIODS: { value: PeriodKind; label: string }[] = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Custom dates" },
];

export default async function EarningsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const period = resolvePeriod({ period: one(sp.period), from: one(sp.from), to: one(sp.to) });
  const cursor = one(sp.cursor);
  const { access, data } = await consolePage(async () => {
    const [earnings, balance] = await Promise.all([
      load<Earnings>(`/v1/astrologer/me/earnings?${earningsQuery(period, cursor)}`),
      load<Balance>("/v1/astrologer/me/balance"),
    ]);
    return { earnings, balance };
  });
  if (access.kind === "anon") return null;
  if (access.kind !== "live" || !data) {
    return access.kind === "live" ? null : <StatusNotice access={access} />;
  }
  const { earnings, balance } = data;

  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Earnings</h1>
      <p className="mt-2 text-sm text-muted">
        From the ledger: what clients paid for your consultations (gross), the platform&apos;s
        commission, your share of refunds, and what you earn (net). Promotional minutes are paid the
        same as paid minutes. Dates are IST.
      </p>

      <section
        aria-labelledby="balance-h"
        className="mt-6 rounded-md border border-border bg-surface p-5"
      >
        <h2 id="balance-h" className="text-lg font-semibold">
          Payable balance
        </h2>
        {balance.ok ? (
          <div className="mt-2 flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <p>
              <span className="text-3xl font-semibold tabular-nums">
                {formatRupees(balance.value.payable_paise)}
              </span>{" "}
              <span className="text-sm text-muted">earned and not yet paid out</span>
            </p>
            <p className="text-sm">
              {balance.value.last_payout ? (
                <>
                  Last payout: {formatRupees(balance.value.last_payout.net_paise)} for{" "}
                  {formatMonth(balance.value.last_payout.period)}
                  {balance.value.last_payout.paid_at &&
                    `, paid ${formatIst(balance.value.last_payout.paid_at)}`}
                  .{" "}
                  <Link href="/payouts" className="underline">
                    Statements
                  </Link>
                </>
              ) : (
                "No payout yet. Statements are prepared after each month ends."
              )}
            </p>
          </div>
        ) : (
          <p className="mt-2 text-sm text-danger">Could not load your balance: {balance.error}</p>
        )}
      </section>

      <form method="get" action="/earnings" className="mt-6 rounded-md border border-border p-4">
        <fieldset>
          <legend className="text-sm font-semibold">Period</legend>
          <div className="mt-2 flex flex-wrap gap-4 text-sm">
            {PERIODS.map((p) => (
              <label key={p.value} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="period"
                  value={p.value}
                  defaultChecked={period.kind === p.value}
                />
                {p.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-3 flex flex-wrap items-end gap-3 text-sm">
          <label>
            <span className="block text-muted">From (custom)</span>
            <input
              type="date"
              name="from"
              defaultValue={period.from}
              className="mt-1 rounded-sm border border-border bg-bg px-2 py-1"
            />
          </label>
          <label>
            <span className="block text-muted">To (custom)</span>
            <input
              type="date"
              name="to"
              defaultValue={period.to}
              className="mt-1 rounded-sm border border-border bg-bg px-2 py-1"
            />
          </label>
          <button className="rounded-sm bg-primary px-3 py-1.5 text-primary-fg">Show</button>
        </div>
        {period.error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {period.error} Showing this month instead.
          </p>
        )}
      </form>

      {!earnings.ok ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-danger px-4 py-3 text-sm text-danger"
        >
          Could not load earnings: {earnings.error}
        </p>
      ) : (
        <EarningsBody e={earnings.value} cursor={cursor} period={period} />
      )}
    </main>
  );
}

function EarningsBody({
  e,
  cursor,
  period,
}: {
  e: Earnings;
  cursor: string;
  period: ReturnType<typeof resolvePeriod>;
}) {
  const t = e.totals;
  const days = dayBars(e.by_day ?? []);
  const cards = [
    { label: "Gross", value: formatRupees(t.gross_paise) },
    { label: "Commission", value: formatDeduction(t.commission_paise) },
    { label: "Refunds", value: formatDeduction(t.refunds_paise) },
    { label: "Net (your earnings)", value: formatRupees(t.net_paise), strong: true },
    { label: "Sessions", value: String(t.sessions) },
    { label: "Billed time", value: formatMinutes(t.minutes) },
  ];
  return (
    <>
      <section aria-labelledby="totals-h" className="mt-6">
        <h2 id="totals-h" className="text-lg font-semibold">
          {formatRange(e.from, e.to)}
        </h2>
        <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {cards.map((c) => (
            <div
              key={c.label}
              className={`rounded-md border p-3 ${c.strong ? "border-primary" : "border-border"}`}
            >
              <dt className="text-xs text-muted">{c.label}</dt>
              <dd className={`mt-1 tabular-nums ${c.strong ? "text-xl font-semibold" : "text-lg"}`}>
                {c.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-xs text-muted">
          Net = gross − commission − refunds. Refunds count in the period they were posted.
        </p>
      </section>

      <section aria-labelledby="days-h" className="mt-8">
        <h2 id="days-h" className="text-lg font-semibold">
          By day
        </h2>
        {days.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No earnings in this period.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Earnings per day. Days without sessions are not listed.
              </caption>
              <thead className="border-b border-border text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Day
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Gross
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Net
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Sessions
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date} className="border-b border-border">
                    <th scope="row" className="py-1.5 pr-4 font-normal whitespace-nowrap">
                      {formatDate(d.date)}
                    </th>
                    <td className="py-1.5 pr-4">
                      <div className="flex items-center gap-3">
                        <div className="h-3 w-32 shrink-0 sm:w-56" aria-hidden="true">
                          <div
                            className="h-3 rounded-sm bg-primary"
                            style={{ width: `${d.percent}%` }}
                          />
                        </div>
                        <span className="tabular-nums">{formatRupees(d.gross_paise)}</span>
                      </div>
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">
                      {formatRupees(d.net_paise)}
                    </td>
                    <td className="py-1.5 pr-4 text-right tabular-nums">{d.sessions}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatMinutes(d.minutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="sessions-h" className="mt-8">
        <h2 id="sessions-h" className="text-lg font-semibold">
          Sessions
        </h2>
        {e.sessions.items.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No sessions on this page.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Started (IST)
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Client
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Type
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Minutes
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Gross
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Commission
                  </th>
                  <th scope="col" className="py-2 pr-4 text-right font-medium">
                    Refunds
                  </th>
                  <th scope="col" className="py-2 text-right font-medium">
                    Net
                  </th>
                </tr>
              </thead>
              <tbody>
                {e.sessions.items.map((r) => (
                  <tr key={r.session_id} className="border-b border-border">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIst(r.started_at)}</td>
                    <td className="py-2 pr-4">{r.client_label}</td>
                    <td className="py-2 pr-4">{r.kind === "call" ? "Call" : "Chat"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{r.billed_minutes}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatRupees(r.gross_paise)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatDeduction(r.commission_paise)}
                    </td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {formatDeduction(r.refunds_paise)}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">
                      {formatRupees(r.net_paise)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-4 flex gap-4 text-sm">
          {cursor && (
            <Link href={earningsHref(period)} className="underline">
              First page
            </Link>
          )}
          {e.sessions.next_cursor && (
            <Link href={earningsHref(period, e.sessions.next_cursor)} className="underline">
              Next page
            </Link>
          )}
        </div>
      </section>
    </>
  );
}
