import { calendarDate, IST } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/ActionForm";
import { Amount, MoneyNav } from "@/components/MoneyNav";
import { NotAuthorised } from "@/components/NotAuthorised";
import { PayoutStatus } from "@/components/PayoutStatus";
import { api, ApiError } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { formatIst, ID } from "@/lib/money-admin";
import {
  allowedActions,
  astrologerName,
  formatPeriod,
  markPaidConsequence,
  TAX_NOTE,
} from "@/lib/payouts";
import type { AdminPayoutDetail } from "@/lib/types";
import { approvePayout, markPayoutPaid, voidPayout } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Payout" };

export default async function PayoutDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ID.test(id)) notFound();
  const { access, data } = await adminPage(async () => {
    try {
      return await api.get<AdminPayoutDetail>(`/v1/admin/payouts/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  });
  if (access.kind !== "admin") return <NotAuthorised />;
  if (!data) notFound();
  const p = data;
  const can = allowedActions(p.status);
  const lines = p.lines ?? [];
  const today = calendarDate(new Date(), IST);
  const backHref = `/money/payouts?${new URLSearchParams({ period: p.period })}`;

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Money</h1>
      <MoneyNav current="/money/payouts" />
      <p className="mt-4 text-sm">
        <Link href={backHref} className="underline">
          Statements for {formatPeriod(p.period)}
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">
          {astrologerName(p)} · {formatPeriod(p.period)}
        </h2>
        <PayoutStatus status={p.status} />
      </div>
      <p className="mt-1 font-mono text-xs text-muted">Statement {p.id}</p>

      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <section className="rounded-md border border-border bg-surface p-4 md:col-span-2">
          <h3 className="font-semibold">Totals (from the ledger)</h3>
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted">Gross</dt>
            <dd className="text-right">
              <Amount paise={p.gross_paise} />
            </dd>
            <dt className="text-muted">Commission</dt>
            <dd className="text-right">
              <Amount paise={-p.commission_paise} />
            </dd>
            <dt className="text-muted">Refunds (astrologer share)</dt>
            <dd className="text-right">
              <Amount paise={-p.refunds_paise} />
            </dd>
            <dt className="font-semibold">Net</dt>
            <dd className="text-right font-semibold">
              <Amount paise={p.net_paise} />
            </dd>
            <dt className="text-muted">Carried forward</dt>
            <dd className="text-right">
              <Amount paise={p.carried_forward_paise} />
            </dd>
            <dt className="text-muted">Sessions / minutes</dt>
            <dd className="text-right tabular-nums">
              {p.sessions} / {p.minutes}
            </dd>
          </dl>
          <p className="mt-3 text-xs text-muted">{TAX_NOTE}</p>
        </section>
        <section className="rounded-md border border-border p-4">
          <h3 className="font-semibold">Progress</h3>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Generated</dt>
            <dd>{formatIst(p.generated_at)}</dd>
            <dt className="text-muted">Approved</dt>
            <dd>{formatIst(p.approved_at)}</dd>
            <dt className="text-muted">Paid</dt>
            <dd>{formatIst(p.paid_at)}</dd>
            <dt className="text-muted">Reference</dt>
            <dd className="font-mono">{p.reference ?? "–"}</dd>
          </dl>
          <h3 className="mt-4 font-semibold">Bank details</h3>
          {p.bank && Object.keys(p.bank).length > 0 ? (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {Object.entries(p.bank).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted">{k.replace(/_/g, " ")}</dt>
                  <dd className="font-mono">{v === null || v === "" ? "–" : String(v)}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-1 text-sm text-muted">
              Not collected yet. Use the details on file with the team.
            </p>
          )}
        </section>
      </div>

      <section className="mt-6 space-y-4">
        <h3 className="text-lg font-semibold">Actions</h3>
        {!can.approve && !can.pay && !can.void && (
          <p className="text-sm text-muted">
            {p.status === "paid"
              ? "Paid. The ledger transaction payout:" + p.id + " is posted; nothing more to do."
              : "Void. Nothing more to do."}
          </p>
        )}
        {can.approve && (
          <div className="rounded-md border border-border p-4">
            <h4 className="font-medium">Approve</h4>
            <p className="mt-1 text-sm text-muted">
              Freezes the figures for payment (generating again no longer changes them). No money
              moves yet. Recorded in the audit log under your account.
            </p>
            <ActionForm
              action={approvePayout.bind(null, p.id)}
              submitLabel="Approve"
              confirm={`Approve ${astrologerName(p)}'s statement for ${formatPeriod(p.period)}?`}
              className="mt-2"
            />
          </div>
        )}
        {can.pay && (
          <div className="rounded-md border border-border p-4">
            <h4 className="font-medium">Mark paid</h4>
            <p className="mt-1 text-sm text-muted">
              Only after the bank transfer of <Amount paise={p.net_paise} /> has gone through.{" "}
              {markPaidConsequence(p)} Paying more than the astrologer&apos;s payable balance is
              refused.
            </p>
            <ActionForm
              action={markPayoutPaid.bind(null, p.id)}
              submitLabel="Mark paid"
              confirm="Post the payout to the ledger now?"
              className="mt-2"
            >
              <div className="flex flex-wrap gap-3">
                <label className="block text-sm">
                  Bank reference (UTR)
                  <input
                    name="reference"
                    required
                    minLength={4}
                    maxLength={64}
                    autoComplete="off"
                    className="mt-1 block rounded-sm border border-border bg-bg px-2 py-1 font-mono"
                  />
                </label>
                <label className="block text-sm">
                  Paid on (IST)
                  <input
                    type="date"
                    name="paid_on"
                    required
                    defaultValue={today}
                    max={today}
                    className="mt-1 block rounded-sm border border-border bg-bg px-2 py-1"
                  />
                </label>
              </div>
            </ActionForm>
          </div>
        )}
        {can.void && (
          <div className="rounded-md border border-danger p-4">
            <h4 className="font-medium">Void</h4>
            <p className="mt-1 text-sm text-muted">
              Cancels this statement; nothing is paid and the earnings stay in the astrologer&apos;s
              payable balance. Only drafts and approved statements can be voided. The note goes to
              the audit log under your account (no bank or personal details).
            </p>
            <ActionForm
              action={voidPayout.bind(null, p.id)}
              submitLabel="Void statement"
              confirm="Void this statement?"
              destructive
              className="mt-2"
            >
              <label className="block text-sm">
                Note (required)
                <input
                  name="note"
                  required
                  minLength={5}
                  maxLength={500}
                  className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
                />
              </label>
            </ActionForm>
          </div>
        )}
      </section>

      {p.adjustments && p.adjustments.length > 0 && (
        <section className="mt-8">
          <h3 className="text-lg font-semibold">Adjustments</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {p.adjustments.map((a, i) => (
              <li
                key={i}
                className="flex flex-wrap justify-between gap-3 border-b border-border py-1.5"
              >
                <span>{a.description ?? a.note ?? a.kind?.replace(/_/g, " ") ?? "Adjustment"}</span>
                {typeof a.amount_paise === "number" && <Amount paise={a.amount_paise} signed />}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h3 className="text-lg font-semibold">Session lines ({lines.length})</h3>
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
                    Session
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
                {lines.map((l) => (
                  <tr key={l.session_id} className="border-b border-border">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIst(l.started_at)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{l.session_id}</td>
                    <td className="py-2 pr-4">{l.kind === "call" ? "Call" : "Chat"}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">{l.billed_minutes}</td>
                    <td className="py-2 pr-4 text-right">
                      <Amount paise={l.gross_paise} />
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Amount paise={l.commission_paise} />
                    </td>
                    <td className="py-2 pr-4 text-right">
                      <Amount paise={l.refunds_paise} />
                    </td>
                    <td className="py-2 text-right">
                      <Amount paise={l.net_paise} />
                    </td>
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
