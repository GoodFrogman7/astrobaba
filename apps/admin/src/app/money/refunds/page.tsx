import type { Metadata } from "next";
import Link from "next/link";
import { LoadError } from "@/components/LoadError";
import { Amount, MoneyNav } from "@/components/MoneyNav";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst, ID, newIdempotencyKey, ruleLabel } from "@/lib/money-admin";
import type { AdminRefund, Page } from "@/lib/types";
import { RefundForm } from "./RefundForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Refunds" };

export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string; session_id?: string }>;
}) {
  const sp = await searchParams;
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const prefill = typeof sp.session_id === "string" && ID.test(sp.session_id) ? sp.session_id : "";
  const { access, data } = await adminPage(() =>
    tryLoad(async () => {
      const params = new URLSearchParams({ limit: "25" });
      if (cursor) params.set("cursor", cursor);
      return api.get<Page<AdminRefund>>(`/v1/admin/money/refunds?${params}`);
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Money</h1>
      <MoneyNav current="/money/refunds" />

      <section
        aria-labelledby="manual-h"
        className="mt-6 rounded-md border border-border bg-surface p-5"
      >
        <h2 id="manual-h" className="text-lg font-semibold">
          Manual goodwill refund
        </h2>
        <p className="mt-1 text-sm text-muted">
          Automatic refunds (failed connect, astrologer drop, low rating) run on their own. Use this
          only for goodwill cases. Every refund is a ledger entry and an audit log entry under your
          account.
        </p>
        <RefundForm defaultSessionId={prefill} initialKey={newIdempotencyKey()} />
      </section>

      <h2 className="mt-8 text-lg font-semibold">Refunds</h2>
      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-4 text-muted">No refunds yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  When (IST)
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Rule
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Session
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Amount
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Actor
                </th>
                <th scope="col" className="py-2 font-medium">
                  Note
                </th>
              </tr>
            </thead>
            <tbody>
              {data.value.items.map((r) => (
                <tr key={r.id} className="border-b border-border align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">{formatIst(r.created_at)}</td>
                  <td className="py-2 pr-4">{ruleLabel(r.rule)}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.session_id ?? "–"}</td>
                  <td className="py-2 pr-4 text-right">
                    <Amount paise={r.amount_paise} />
                  </td>
                  <td className="py-2 pr-4">{r.actor ?? "system"}</td>
                  <td className="py-2 text-muted">{r.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.ok && data.value.next_cursor && (
        <Link
          href={`/money/refunds?${new URLSearchParams({ cursor: data.value.next_cursor })}`}
          className="mt-4 inline-block text-sm underline"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
