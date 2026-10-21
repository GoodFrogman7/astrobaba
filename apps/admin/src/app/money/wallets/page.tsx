import type { Metadata } from "next";
import Link from "next/link";
import { LoadError } from "@/components/LoadError";
import { Amount, MoneyNav } from "@/components/MoneyNav";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst, ID, txnLabel } from "@/lib/money-admin";
import type { AdminWalletView } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "User wallet" };

export default async function WalletPage({
  searchParams,
}: {
  searchParams: Promise<{ user_id?: string }>;
}) {
  const sp = await searchParams;
  const raw = typeof sp.user_id === "string" ? sp.user_id.trim() : "";
  const userId = ID.test(raw) ? raw : "";
  const { access, data } = await adminPage(async () =>
    userId
      ? tryLoad(() =>
          api.get<AdminWalletView>(`/v1/admin/money/users/${encodeURIComponent(userId)}/wallet`),
        )
      : null,
  );
  if (access.kind !== "admin") return <NotAuthorised />;
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Money</h1>
      <MoneyNav current="/money/wallets" />
      <form className="mt-6 flex flex-wrap gap-2" role="search">
        <label htmlFor="user_id" className="sr-only">
          User id
        </label>
        <input
          id="user_id"
          name="user_id"
          defaultValue={raw}
          placeholder="User id"
          className="w-full max-w-sm rounded-sm border border-border bg-surface px-3 py-1.5 font-mono"
        />
        <button className="rounded-sm border border-border px-3 py-1.5 text-sm">Look up</button>
      </form>
      {raw && !userId && <p className="mt-4 text-sm text-danger">That is not a valid user id.</p>}
      {data && !data.ok && (
        <LoadError error={data.status === 404 ? "no wallet for this user." : data.error} />
      )}
      {data?.ok && (
        <>
          <section aria-labelledby="bal-h" className="mt-6">
            <h2 id="bal-h" className="text-lg font-semibold">
              Balances
            </h2>
            <dl className="mt-3 grid gap-4 sm:grid-cols-3">
              {[
                ["Real", data.value.wallet.real_paise],
                ["Promo (no cash value)", data.value.wallet.promo_paise],
                ["Total", data.value.wallet.total_paise],
              ].map(([label, paise]) => (
                <div
                  key={label as string}
                  className="rounded-md border border-border bg-surface p-4"
                >
                  <dt className="text-sm text-muted">{label}</dt>
                  <dd className="text-2xl font-semibold">
                    <Amount paise={paise as number} />
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-sm">
              Free session:{" "}
              {!data.value.wallet.free_session.enabled
                ? "programme off"
                : data.value.wallet.free_session.eligible
                  ? `eligible (${data.value.wallet.free_session.minutes} min)`
                  : `not eligible${data.value.wallet.free_session.reason ? ` (${data.value.wallet.free_session.reason})` : ""}`}
            </p>
            {data.value.wallet.promo_lots.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm">
                {data.value.wallet.promo_lots.map((l) => (
                  <li key={l.id}>
                    Promo lot <Amount paise={l.remaining_paise} /> left
                    {l.campaign ? ` (${l.campaign})` : ""}, expires {formatIst(l.expires_at)}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-labelledby="txn-h" className="mt-8">
            <h2 id="txn-h" className="text-lg font-semibold">
              Recent transactions
            </h2>
            {data.value.transactions.length === 0 ? (
              <p className="mt-3 text-muted">No transactions.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-border text-muted">
                    <tr>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        When (IST)
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Kind
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">
                        Amount
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">
                        Real
                      </th>
                      <th scope="col" className="py-2 pr-4 text-right font-medium">
                        Promo
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        Session / astrologer
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.value.transactions.map((t) => (
                      <tr key={t.id} className="border-b border-border align-top">
                        <td className="py-2 pr-4 whitespace-nowrap">{formatIst(t.created_at)}</td>
                        <td className="py-2 pr-4">{txnLabel(t.kind)}</td>
                        <td className="py-2 pr-4 text-right">
                          <Amount paise={t.amount_paise} signed />
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <Amount paise={t.real_paise} signed />
                        </td>
                        <td className="py-2 pr-4 text-right">
                          <Amount paise={t.promo_paise} signed />
                        </td>
                        <td className="py-2">
                          {t.session_id && (
                            <Link
                              href={`/money/refunds?${new URLSearchParams({ session_id: t.session_id })}`}
                              className="font-mono text-xs underline"
                              title="Refund this session"
                            >
                              {t.session_id}
                            </Link>
                          )}
                          {t.astrologer && (
                            <span className="ml-2 text-muted">{t.astrologer.display_name}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
