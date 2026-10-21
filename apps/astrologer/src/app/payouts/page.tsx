import type { Payout } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { PayoutBadge } from "@/components/PayoutBadge";
import { tryGet } from "@/lib/api";
import { formatDeduction, formatMonth, payoutStatusText, TAX_NOTE } from "@/lib/earnings";
import { formatIst, formatRupees } from "@/lib/format";
import { consolePage } from "@/lib/guard";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payouts" };

export default async function PayoutsPage() {
  const page = await consolePage(() => tryGet<{ items: Payout[] }>("/v1/astrologer/me/payouts"));
  if (!page.live) return page.notice;
  const { data } = page;
  return (
    <main id="main" className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Payout statements</h1>
      <p className="mt-2 text-sm text-muted">
        One statement per month (IST), prepared after the month ends. Bank transfers are made by our
        team and marked paid with the bank reference. If a month&apos;s earnings are below the
        minimum payout, they are carried forward to the next month.
      </p>
      <p className="mt-2 text-sm text-muted">{TAX_NOTE}</p>
      {!data.ok ? (
        <p
          role="alert"
          className="mt-6 rounded-md border border-danger px-4 py-3 text-sm text-danger"
        >
          Could not load your statements: {data.error}
        </p>
      ) : data.value.items.length === 0 ? (
        <p className="mt-8 text-muted">
          No statements yet. The first one appears after your first month.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Month
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
                <th scope="col" className="py-2 font-medium">
                  Paid
                </th>
              </tr>
            </thead>
            <tbody>
              {data.value.items.map((p) => (
                <tr key={p.id} className="border-b border-border align-top">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    <Link href={`/payouts/${encodeURIComponent(p.id)}`} className="underline">
                      {formatMonth(p.period)}
                    </Link>
                  </th>
                  <td className="py-2 pr-4">
                    <PayoutBadge status={p.status} />
                    <span className="mt-1 block max-w-xs text-xs text-muted">
                      {payoutStatusText(p)}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{p.sessions}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatRupees(p.gross_paise)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatDeduction(p.commission_paise)}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {formatDeduction(p.refunds_paise)}
                  </td>
                  <td className="py-2 pr-4 text-right font-medium tabular-nums">
                    {formatRupees(p.net_paise)}
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    {p.status === "paid" ? (
                      <>
                        {formatIst(p.paid_at)}
                        {p.reference && (
                          <span className="block font-mono text-xs text-muted">
                            Ref {p.reference}
                          </span>
                        )}
                      </>
                    ) : (
                      "–"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
