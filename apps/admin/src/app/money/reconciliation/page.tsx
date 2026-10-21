import type { Metadata } from "next";
import { ActionForm } from "@/components/ActionForm";
import { LoadError } from "@/components/LoadError";
import { Amount, MoneyNav } from "@/components/MoneyNav";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst, yesterdayIst } from "@/lib/money-admin";
import type { Page, ReconRun } from "@/lib/types";
import { runReconciliation } from "../actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reconciliation" };

const BADGE: Record<string, string> = {
  ok: "bg-success text-primary-fg",
  drift: "bg-danger text-primary-fg",
  error: "bg-danger text-primary-fg",
};

export default async function ReconciliationPage() {
  const { access, data } = await adminPage(() =>
    tryLoad(() => api.get<Page<ReconRun>>("/v1/admin/money/reconciliation")),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const yesterday = yesterdayIst();
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Money</h1>
      <MoneyNav current="/money/reconciliation" />

      <section className="mt-6 rounded-md border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold">Run now</h2>
        <p className="mt-1 text-sm text-muted">
          The job runs daily for yesterday (IST). It checks that every ledger transaction balances,
          balances and promo lots match their entries, each captured payment has exactly one
          recharge credit, and settlements match the gateway report. It only reads and reports; it
          never moves money.
        </p>
        <ActionForm
          action={runReconciliation}
          submitLabel="Run reconciliation"
          confirm="Run reconciliation for this date now? The run is recorded, and any drift raises an alert."
          className="mt-3"
        >
          <label className="block text-sm">
            Date (IST)
            <input
              type="date"
              name="date"
              required
              defaultValue={yesterday}
              max={yesterday}
              className="mt-1 block rounded-sm border border-border bg-bg px-2 py-1"
            />
          </label>
        </ActionForm>
      </section>

      <h2 className="mt-8 text-lg font-semibold">Runs</h2>
      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-4 text-muted">No runs yet.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {data.value.items.map((r) => (
            <li key={r.id} className="rounded-md border border-border bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">
                  {r.date}{" "}
                  <span
                    className={`ml-2 rounded-sm px-1.5 py-0.5 text-xs uppercase ${BADGE[r.status] ?? "border border-border"}`}
                  >
                    {r.status}
                  </span>
                </span>
                <span className="text-sm">
                  Drift: <Amount paise={r.drift_paise} />
                  {r.finished_at && (
                    <span className="text-muted"> · finished {formatIst(r.finished_at)}</span>
                  )}
                </span>
              </div>
              {r.checks.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {r.checks.map((c, i) => (
                    <li key={`${c.name}-${i}`} className="flex flex-wrap gap-2">
                      <span className={c.status === "ok" ? "text-success" : "text-danger"}>
                        {c.status === "ok" ? "✓" : "✗"}
                      </span>
                      <span>{c.name.replace(/_/g, " ")}</span>
                      {!!c.drift_paise && (
                        <span>
                          (<Amount paise={c.drift_paise} />)
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
