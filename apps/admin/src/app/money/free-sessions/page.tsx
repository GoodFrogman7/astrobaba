import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { LoadError } from "@/components/LoadError";
import { MoneyNav } from "@/components/MoneyNav";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst } from "@/lib/money-admin";
import type { FreeSessionClaim, Page } from "@/lib/types";
import { overrideFreeSession } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Free sessions" };

const OVERRIDES = [
  { value: "allow", text: "Allow: let this user have the free session despite the abuse check" },
  { value: "block", text: "Block: refuse this user a free session" },
  { value: "reset", text: "Reset: remove the override and go back to the automatic check" },
];

export default async function FreeSessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ flagged?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const flagged = sp.flagged === "true";
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const { access, data } = await adminPage(() =>
    tryLoad(async () => {
      const params = new URLSearchParams({ limit: "25" });
      if (flagged) params.set("flagged", "true");
      if (cursor) params.set("cursor", cursor);
      return api.get<Page<FreeSessionClaim>>(`/v1/admin/money/free-sessions?${params}`);
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const tabs = [
    { label: "All claims", href: "/money/free-sessions", on: !flagged },
    { label: "Flagged", href: "/money/free-sessions?flagged=true", on: flagged },
  ];
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Money</h1>
      <MoneyNav current="/money/free-sessions" />
      <h2 className="mt-6 text-lg font-semibold">First free session claims</h2>
      <p className="mt-1 text-sm text-muted">
        One free session per person, checked on phone, device and network signals. The abuse score
        and reasons come from the API. Overrides are written to the audit log under your account.
      </p>
      <nav aria-label="Filter" className="mt-4">
        <ul className="flex gap-1 text-sm">
          {tabs.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={t.on ? "page" : undefined}
                className={`inline-block rounded-sm px-3 py-1.5 ${t.on ? "bg-primary text-primary-fg" : "border border-border"}`}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-6 text-muted">{flagged ? "No flagged claims." : "No claims yet."}</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {data.value.items.map((c) => {
            const reasons = c.reasons.join(", ");
            return (
              <li key={c.user_id} className="rounded-md border border-border bg-surface p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span>
                    User <span className="font-mono">{c.user_id}</span>
                  </span>
                  <span className="text-muted">
                    Claimed {formatIst(c.claimed_at)}
                    {c.session_id && (
                      <>
                        {" "}
                        · session <span className="font-mono">{c.session_id}</span>
                      </>
                    )}
                  </span>
                </div>
                <p className="mt-2 text-sm">
                  Abuse score <strong className="tabular-nums">{c.abuse_score}</strong>
                  {reasons ? <> · {reasons}</> : null}
                </p>
                {c.override && (
                  <p className="mt-1 text-sm text-muted">
                    Override: {c.override.action}
                    {c.override.resets ? ` · reset ${c.override.resets}×` : ""}
                    {c.override.note ? ` (${c.override.note})` : ""}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-4 text-sm">
                  <Link
                    href={`/money/wallets?${new URLSearchParams({ user_id: c.user_id })}`}
                    className="underline"
                  >
                    Wallet
                  </Link>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-sm">Override</summary>
                  <ActionForm
                    action={overrideFreeSession.bind(null, c.user_id)}
                    submitLabel="Save override"
                    confirm="Save this override? It changes whether this user gets a free session and is recorded in the audit log under your name."
                    className="mt-2"
                  >
                    <fieldset className="space-y-1 text-sm">
                      <legend className="sr-only">Override</legend>
                      {OVERRIDES.map((o) => (
                        <label key={o.value} className="flex items-start gap-2">
                          <input
                            type="radio"
                            name="action"
                            value={o.value}
                            required
                            className="mt-1"
                          />
                          <span>{o.text}</span>
                        </label>
                      ))}
                    </fieldset>
                    <label className="block text-sm">
                      Note (required, for the audit log)
                      <input
                        name="note"
                        required
                        minLength={3}
                        className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
                      />
                    </label>
                  </ActionForm>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {data.ok && data.value.next_cursor && (
        <Link
          href={`/money/free-sessions?${new URLSearchParams({
            ...(flagged ? { flagged: "true" } : {}),
            cursor: data.value.next_cursor,
          })}`}
          className="mt-4 inline-block text-sm underline"
        >
          Next page
        </Link>
      )}
    </main>
  );
}
