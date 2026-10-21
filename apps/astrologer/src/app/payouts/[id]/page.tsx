import type { EarningRow, Payout } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PayoutBadge } from "@/components/PayoutBadge";
import { StatusNotice } from "@/components/StatusNotice";
import { api, ApiError } from "@/lib/api";
import {
  formatDeduction,
  formatMinutes,
  formatMonth,
  payoutStatusText,
  TAX_NOTE,
} from "@/lib/earnings";
import { formatIst, formatRupees } from "@/lib/format";
import { OPAQUE_ID } from "@/lib/forward";
import { consolePage } from "@/lib/guard";
import type { PayoutAdjustment } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payout statement" };

type PayoutDetail = Payout & { lines?: EarningRow[]; adjustments?: PayoutAdjustment[] };

export default async function PayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!OPAQUE_ID.test(id)) notFound();
  const { access, data } = await consolePage(async () => {
    try {
      return await api.get<PayoutDetail>(`/v1/astrologer/me/payouts/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  });
  if (access.kind === "anon") return null;
  if (access.kind !== "live") return <StatusNotice access={access} />;
  if (!data) notFound();
  const p = data;
  const lines = p.lines ?? [];
  const adjustments = p.adjustments ?? [];
  const rows = [
    { label: "Gross", value: formatRupees(p.gross_paise) },
    { label: "Platform commission", value: formatDeduction(p.commission_paise) },
    { label: "Refunds", value: formatDeduction(p.refunds_paise) },
    { label: "Net payable", value: formatRupees(p.net_paise), strong: true },
  ];
  if (p.carried_forward_paise) {
    rows.push({
      label: "Carried forward to next month",
      value: formatRupees(p.carried_forward_paise),
    });
  }
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-8">
      <p className="text-sm">
        <Link href="/payouts" className="underline">
          All statements
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Statement for {formatMonth(p.period)}</h1>
        <a
          href={`/api/payouts/${encodeURIComponent(p.id)}/statement.csv`}
          download
          className="rounded-sm border border-border px-3 py-1.5 text-sm"
        >
          Download CSV
        </a>
      </div>
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        <PayoutBadge status={p.status} /> {payoutStatusText(p)}
      </p>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section aria-labelledby="sum-h" className="rounded-md border border-border bg-surface p-5">
          <h2 id="sum-h" className="font-semibold">
            Summary
          </h2>
          <dl className="mt-3 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-sm">
            {rows.map((r) => (
              <div key={r.label} className="contents">
                <dt className={r.strong ? "font-semibold" : "text-muted"}>{r.label}</dt>
                <dd className={`text-right tabular-nums ${r.strong ? "font-semibold" : ""}`}>
                  {r.value}
                </dd>
              </div>
            ))}
            <dt className="text-muted">Sessions</dt>
            <dd className="text-right tabular-nums">{p.sessions}</dd>
            <dt className="text-muted">Billed time</dt>
            <dd className="text-right tabular-nums">{formatMinutes(p.minutes)}</dd>
          </dl>
        </section>
        <section aria-labelledby="dates-h" className="rounded-md border border-border p-5">
          <h2 id="dates-h" className="font-semibold">
            Progress
          </h2>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
            <dt className="text-muted">Prepared</dt>
            <dd>{formatIst(p.generated_at)}</dd>
            <dt className="text-muted">Approved</dt>
            <dd>{formatIst(p.approved_at)}</dd>
            <dt className="text-muted">Paid</dt>
            <dd>{formatIst(p.paid_at)}</dd>
            {p.reference && (
              <>
                <dt className="text-muted">Bank reference</dt>
                <dd className="font-mono">{p.reference}</dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <p className="mt-4 rounded-md border border-border px-4 py-3 text-sm">{TAX_NOTE}</p>

      {adjustments.length > 0 && (
        <section aria-labelledby="adj-h" className="mt-8">
          <h2 id="adj-h" className="text-lg font-semibold">
            Adjustments
          </h2>
          <ul className="mt-2 space-y-1 text-sm">
            {adjustments.map((a, i) => (
              <li
                key={i}
                className="flex flex-wrap justify-between gap-3 border-b border-border py-1.5"
              >
                <span>
                  {a.description ??
                    a.note ??
                    a.reason ??
                    a.kind?.replace(/_/g, " ") ??
                    "Adjustment"}
                </span>
                {typeof a.amount_paise === "number" && (
                  <span className="tabular-nums">{formatRupees(a.amount_paise)}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="lines-h" className="mt-8">
        <h2 id="lines-h" className="text-lg font-semibold">
          Sessions in this statement
        </h2>
        {lines.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No session lines.</p>
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
                {lines.map((r) => (
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
                    <td className="py-2 text-right tabular-nums">{formatRupees(r.net_paise)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
