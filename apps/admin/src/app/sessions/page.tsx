import type { Metadata } from "next";
import Link from "next/link";
import { Amount } from "@/components/MoneyNav";
import { LoadError } from "@/components/LoadError";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { asItems, formatIst } from "@/lib/money-admin";
import type { AdminSession } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sessions" };

const FILTERS = [
  "",
  "active",
  "queued",
  "requested",
  "accepted",
  "completed",
  "cancelled",
  "failed",
];

/** Recent consultation sessions. Metadata only: message content is never requested or shown. */
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const status = FILTERS.includes(sp.status ?? "") ? (sp.status ?? "") : "";
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const { access, data } = await adminPage(() =>
    tryLoad(async () => {
      const params = new URLSearchParams({ limit: "50" });
      if (status) params.set("status", status);
      if (cursor) params.set("cursor", cursor);
      return asItems<AdminSession>(await api.get(`/v1/admin/sessions?${params}`));
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Sessions</h1>
      <p className="mt-1 text-sm text-muted">
        Recent consultations. Chat messages are private and are not shown here.
      </p>
      <nav aria-label="Status" className="mt-4 overflow-x-auto">
        <ul className="flex gap-1 text-sm">
          {FILTERS.map((f) => (
            <li key={f || "all"}>
              <Link
                href={f ? `/sessions?status=${f}` : "/sessions"}
                aria-current={f === status ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 ${f === status ? "bg-primary text-primary-fg" : "border border-border"}`}
              >
                {f ? f[0]!.toUpperCase() + f.slice(1) : "All"}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-6 text-muted">No sessions.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-muted">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Created (IST)
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Astrologer
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Client
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Rate
                </th>
                <th scope="col" className="py-2 pr-4 text-right font-medium">
                  Billed
                </th>
                <th scope="col" className="py-2 font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {data.value.items.map((s) => (
                <tr key={s.id} className="border-b border-border align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {formatIst(s.created_at)}
                    <span className="block font-mono text-xs text-muted">{s.id}</span>
                  </td>
                  <td className="py-2 pr-4">
                    {s.astrologer ? (
                      <Link href={`/astrologers/${s.astrologer.id}`} className="underline">
                        {s.astrologer.display_name}
                      </Link>
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {s.client_label ?? "–"}
                    {s.user_id && (
                      <span className="block font-mono text-xs text-muted">{s.user_id}</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {s.status}
                    {s.end_reason && (
                      <span className="block text-xs text-muted">
                        {s.end_reason.replace(/_/g, " ")}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {s.is_free ? "Free" : <Amount paise={s.price_per_min_paise} />}
                    {!s.is_free && "/min"}
                  </td>
                  <td className="py-2 pr-4 text-right whitespace-nowrap">
                    {s.billed_minutes} min
                    <span className="block">
                      <Amount paise={s.billed_paise} />
                    </span>
                  </td>
                  <td className="py-2 text-sm">
                    <span className="flex flex-col gap-1">
                      {s.user_id && (
                        <Link
                          href={`/money/wallets?${new URLSearchParams({ user_id: s.user_id })}`}
                          className="underline"
                        >
                          Wallet
                        </Link>
                      )}
                      {s.billed_paise > 0 && (
                        <Link
                          href={`/money/refunds?${new URLSearchParams({ session_id: s.id })}`}
                          className="underline"
                        >
                          Refund…
                        </Link>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.ok && data.value.next_cursor && (
        <Link
          href={`/sessions?${new URLSearchParams({ ...(status ? { status } : {}), cursor: data.value.next_cursor })}`}
          className="mt-4 inline-block text-sm underline"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
