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
  asList,
  balanceText,
  canExecute,
  deletionBlockers,
  deletionFilter,
  deletionStatusLabel,
  EXECUTE_EFFECT,
  openSessionsText,
  type DeletionFilter,
  type DeletionRequest,
} from "@/lib/trust-admin";
import { executeDeletion } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Deletion requests" };

const FILTER_LABEL: Record<DeletionFilter, string> = { requested: "Open", all: "All" };

function href(filter: DeletionFilter, cursor?: string) {
  const p = new URLSearchParams();
  if (filter !== "requested") p.set("status", filter);
  if (cursor) p.set("cursor", cursor);
  const q = p.toString();
  return q ? `/privacy/deletions?${q}` : "/privacy/deletions";
}

/** Account deletion requests (docs/api/trust.md §2): executed by an admin, never automatically. */
export default async function DeletionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const filter = deletionFilter(sp.status);
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const { access, data } = await adminPage(() =>
    tryLoad(async () => {
      const params = new URLSearchParams();
      if (filter === "requested") params.set("status", "requested");
      if (cursor) params.set("cursor", cursor);
      const q = params.toString();
      return asList<DeletionRequest>(
        await api.get<unknown>(`/v1/admin/deletions${q ? `?${q}` : ""}`),
      );
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Account deletion requests</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Users ask for deletion from their account page; the account keeps working until a request is
        executed here, and the user can cancel it until then. Execute only once no session is open
        and the wallet balance is settled (₹0).
      </p>
      <nav aria-label="Filter" className="mt-4">
        <ul className="flex gap-1 text-sm">
          {(["requested", "all"] as const).map((f) => (
            <li key={f}>
              <Link
                href={href(f)}
                prefetch={false}
                aria-current={f === filter ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 ${
                  f === filter ? "bg-primary text-primary-fg" : "border border-border"
                }`}
              >
                {FILTER_LABEL[f]}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-8 text-muted">
          {filter === "requested" ? "No open deletion requests." : "No deletion requests."}
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Requested (IST)
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  User
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Open sessions
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Wallet balance
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.value.items.map((r) => {
                const blockers = deletionBlockers(r);
                return (
                  <tr key={r.id} className="border-b border-border align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIst(r.requested_at)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      <Link
                        href={`/money/wallets?${new URLSearchParams({ user_id: r.user_id })}`}
                        className="underline"
                      >
                        {r.user_id}
                      </Link>
                    </td>
                    <td className="py-2 pr-4">
                      {deletionStatusLabel(r.status)}
                      {r.executed_at ? ` · ${formatIst(r.executed_at)}` : ""}
                    </td>
                    <td className="py-2 pr-4">{openSessionsText(r.open_sessions)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums">
                      {balanceText(r.wallet_balance_paise)}
                    </td>
                    <td className="py-2">
                      {canExecute(r) && (
                        <div className="max-w-sm space-y-1">
                          {blockers.length > 0 && (
                            <p className="text-xs text-danger">
                              {blockers.join(" · ")}: the API will refuse until this is settled.
                            </p>
                          )}
                          <details>
                            <summary className="cursor-pointer text-sm font-medium">
                              Execute…
                            </summary>
                            <p className="mt-1 text-xs text-muted">{EXECUTE_EFFECT}</p>
                            <ActionForm
                              action={executeDeletion.bind(null, r.id)}
                              submitLabel="Delete account data"
                              confirm="Delete this user's data for good?"
                              destructive
                              className="mt-2"
                            />
                          </details>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data.ok && data.value.next_cursor && (
        <Link
          href={href(filter, data.value.next_cursor)}
          prefetch={false}
          className="mt-4 inline-block text-sm underline"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
