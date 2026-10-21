import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { LoadError } from "@/components/LoadError";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst } from "@/lib/money-admin";
import {
  REPORT_STATUSES,
  REPORT_STATUS_LABEL,
  SKU_LABEL,
  canRetry,
  ownerOf,
  reportStatusFilter,
  type AdminReportRow,
} from "@/lib/reports-admin";
import type { Page } from "@/lib/types";
import { retryReport } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reports" };

const TABS = [null, ...REPORT_STATUSES] as const;

function href(status: string | null, cursor?: string) {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (cursor) p.set("cursor", cursor);
  const q = p.toString();
  return q ? `/reports?${q}` : "/reports";
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const status = reportStatusFilter(sp.status);
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const { access, data } = await adminPage(() =>
    tryLoad(() => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (cursor) params.set("cursor", cursor);
      const q = params.toString();
      return api.get<Page<AdminReportRow>>(`/v1/admin/reports${q ? `?${q}` : ""}`);
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Paid reports</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Render status only; birth details are never shown here. A report that fails five times is
        refunded automatically. Retrying a failed report queues it again and never charges the user
        again.
      </p>
      <nav aria-label="Report status" className="mt-4 overflow-x-auto">
        <ul className="flex gap-1 text-sm">
          {TABS.map((t) => (
            <li key={t ?? "all"}>
              <Link
                href={href(t)}
                prefetch={false}
                aria-current={t === status ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 whitespace-nowrap ${
                  t === status ? "bg-primary text-primary-fg" : "border border-border"
                }`}
              >
                {t ? REPORT_STATUS_LABEL[t] : "All"}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-8 text-muted">
          No {status ? REPORT_STATUS_LABEL[status].toLowerCase() : ""} reports.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Created (IST)
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Product
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Attempts
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Last error
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Report / owner
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.value.items.map((r) => (
                <tr key={r.id} className="border-b border-border align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">{formatIst(r.created_at)}</td>
                  <td className="py-2 pr-4">
                    {SKU_LABEL[r.sku] ?? r.sku}
                    {r.language ? ` (${r.language})` : ""}
                  </td>
                  <td className="py-2 pr-4">
                    {REPORT_STATUS_LABEL[r.status] ?? r.status}
                    {r.refunded ? " · refunded" : ""}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{r.attempts}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{r.last_error_code ?? "–"}</td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    <span className="block">{r.id}</span>
                    <span className="block text-muted">{ownerOf(r)}</span>
                  </td>
                  <td className="py-2">
                    {canRetry(r) && (
                      <ActionForm
                        action={retryReport.bind(null, r.id)}
                        submitLabel="Retry"
                        confirm="Queue this report again (free for the user)?"
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.ok && data.value.next_cursor && (
        <Link
          href={href(status, data.value.next_cursor)}
          prefetch={false}
          className="mt-4 inline-block text-sm underline"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
