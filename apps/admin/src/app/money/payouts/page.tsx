import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { LoadError } from "@/components/LoadError";
import { Amount, MoneyNav } from "@/components/MoneyNav";
import { NotAuthorised } from "@/components/NotAuthorised";
import { PayoutStatus } from "@/components/PayoutStatus";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { asItems, formatIst } from "@/lib/money-admin";
import {
  astrologerName,
  formatPeriod,
  PAYOUT_STATUSES,
  periodFilter,
  previousIstMonth,
  STATUS_LABEL,
  statusFilter,
  sumPayouts,
  TAX_NOTE,
} from "@/lib/payouts";
import type { AdminPayout } from "@/lib/types";
import { generatePayouts } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; status?: string }>;
}) {
  const sp = await searchParams;
  const period = periodFilter(typeof sp.period === "string" ? sp.period : undefined);
  const status = statusFilter(typeof sp.status === "string" ? sp.status : undefined);
  const { access, data } = await adminPage(() =>
    tryLoad(async () => {
      const q = new URLSearchParams({ period });
      if (status) q.set("status", status);
      return asItems<AdminPayout>(await api.get(`/v1/admin/payouts?${q}`));
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const lastMonth = previousIstMonth();
  const href = (s: string | null) =>
    `/money/payouts?${new URLSearchParams({ period, ...(s ? { status: s } : {}) })}`;
  const tabs = [
    { label: "All", value: null },
    ...PAYOUT_STATUSES.map((s) => ({ label: STATUS_LABEL[s], value: s })),
  ];
  const rows = data.ok ? data.value.items : [];
  const t = sumPayouts(rows);

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Money</h1>
      <MoneyNav current="/money/payouts" />

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <form method="get" action="/money/payouts" className="rounded-md border border-border p-4">
          <h2 className="font-semibold">Period</h2>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-sm">
              Month (IST)
              <input
                type="month"
                name="period"
                defaultValue={period}
                required
                className="mt-1 block rounded-sm border border-border bg-bg px-2 py-1"
              />
            </label>
            {status && <input type="hidden" name="status" value={status} />}
            <button className="rounded-sm border border-border px-3 py-1.5 text-sm">Show</button>
          </div>
        </form>

        <section className="rounded-md border border-border bg-surface p-4">
          <h2 className="font-semibold">Generate statements</h2>
          <p className="mt-1 text-sm text-muted">
            The job runs on the 1st for the previous month. Generating again recalculates{" "}
            <strong>draft</strong> statements from the ledger only; approved, paid and void ones are
            kept. Net amounts below the minimum payout are carried forward (status void). Audited.
          </p>
          <ActionForm
            action={generatePayouts}
            submitLabel="Generate for period"
            confirm="Generate statements for this month now? Drafts for the month are recalculated; this is recorded in the audit log under your account."
            className="mt-3"
          >
            <label className="block text-sm">
              Month (IST, must have ended)
              <input
                type="month"
                name="period"
                required
                defaultValue={period <= lastMonth ? period : lastMonth}
                max={lastMonth}
                className="mt-1 block rounded-sm border border-border bg-bg px-2 py-1"
              />
            </label>
          </ActionForm>
        </section>
      </div>

      <h2 className="mt-8 text-lg font-semibold">Statements for {formatPeriod(period)}</h2>
      <p className="mt-1 text-sm text-muted">
        Workflow: draft → approve → make the bank transfer → mark paid with the bank reference
        (posts the ledger entry). Void a draft or approved statement that should not be paid.{" "}
        {TAX_NOTE}
      </p>
      <nav aria-label="Status" className="mt-4">
        <ul className="flex flex-wrap gap-1 text-sm">
          {tabs.map((tab) => {
            const on = status === tab.value;
            return (
              <li key={tab.label}>
                <Link
                  href={href(tab.value)}
                  aria-current={on ? "page" : undefined}
                  className={`inline-block rounded-sm px-3 py-1.5 ${on ? "bg-primary text-primary-fg" : "border border-border"}`}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {!data.ok ? (
        <LoadError error={data.error} />
      ) : rows.length === 0 ? (
        <p className="mt-6 text-muted">
          No {status ? `${STATUS_LABEL[status].toLowerCase()} ` : ""}statements for this month.
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Astrologer
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Sessions
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
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Net
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Carried fwd
                </th>
                <th scope="col" className="py-2 font-medium">
                  Paid / reference
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className="border-b border-border align-top">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    <Link href={`/money/payouts/${encodeURIComponent(p.id)}`} className="underline">
                      {astrologerName(p)}
                    </Link>
                  </th>
                  <td className="py-2 pr-4">
                    <PayoutStatus status={p.status} />
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{p.sessions}</td>
                  <td className="py-2 pr-4 text-right">
                    <Amount paise={p.gross_paise} />
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <Amount paise={p.commission_paise} />
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <Amount paise={p.refunds_paise} />
                  </td>
                  <td className="py-2 pr-4 text-right font-medium">
                    <Amount paise={p.net_paise} />
                  </td>
                  <td className="py-2 pr-4 text-right">
                    {p.carried_forward_paise ? <Amount paise={p.carried_forward_paise} /> : "–"}
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    {p.paid_at ? formatIst(p.paid_at) : "–"}
                    {p.reference && (
                      <span className="block font-mono text-xs text-muted">{p.reference}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="font-medium">
              <tr>
                <th scope="row" className="py-2 pr-4 text-left">
                  Total ({t.count} shown)
                </th>
                <td className="py-2 pr-4" />
                <td className="py-2 pr-4 text-right tabular-nums">
                  {rows.reduce((n, r) => n + r.sessions, 0)}
                </td>
                <td className="py-2 pr-4 text-right">
                  <Amount paise={t.gross_paise} />
                </td>
                <td className="py-2 pr-4 text-right">
                  <Amount paise={t.commission_paise} />
                </td>
                <td className="py-2 pr-4 text-right">
                  <Amount paise={t.refunds_paise} />
                </td>
                <td className="py-2 pr-4 text-right">
                  <Amount paise={t.net_paise} />
                </td>
                <td className="py-2 pr-4 text-right">
                  <Amount paise={t.carried_forward_paise} />
                </td>
                <td className="py-2 text-xs font-normal text-muted">
                  Net excluding void: <Amount paise={t.payable_net_paise} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </main>
  );
}
