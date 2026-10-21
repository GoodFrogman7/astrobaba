import type { LaunchReadiness, ReadinessCheck } from "@astro/shared";
import type { Metadata } from "next";
import { LoadError } from "@/components/LoadError";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { readinessLabel, readinessTotals, sortChecks } from "@/lib/growth-admin";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst } from "@/lib/money-admin";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Launch readiness" };

const STATUS: Record<ReadinessCheck["status"], { icon: string; text: string; className: string }> =
  {
    fail: { icon: "✕", text: "Fail", className: "border-danger text-danger" },
    warn: { icon: "!", text: "Warn", className: "border-accent" },
    pass: { icon: "✓", text: "Pass", className: "border-success text-success" },
  };

/** Launch readiness (growth.md §5): every check is computed live by the API. */
export default async function LaunchPage() {
  const { access, data } = await adminPage(() =>
    tryLoad(() => api.get<LaunchReadiness>("/v1/admin/launch-readiness")),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const checks = data.ok ? sortChecks(data.value.checks) : [];
  const totals = readinessTotals(checks);

  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Launch readiness</h1>
      {!data.ok ? (
        <LoadError error={data.error} />
      ) : checks.length === 0 ? (
        <p className="mt-6 text-muted">The API returned no checks.</p>
      ) : (
        <>
          <p className="mt-2 text-sm">
            <span className="font-medium">{totals.fail} failing</span> ·{" "}
            <span className="font-medium">{totals.warn} warning</span> ·{" "}
            <span className="font-medium">{totals.pass} passing</span>
            <span className="text-muted"> · checked {formatIst(data.value.generated_at)} IST</span>
          </p>
          <ul className="mt-6 space-y-2">
            {checks.map((c) => {
              const st = STATUS[c.status] ?? {
                icon: "?",
                text: c.status,
                className: "border-border",
              };
              return (
                <li
                  key={c.id}
                  className="flex gap-3 rounded-md border border-border bg-surface p-3"
                >
                  <span
                    className={`inline-flex h-fit shrink-0 items-center gap-1 rounded-sm border px-2 py-0.5 text-sm font-semibold ${st.className}`}
                  >
                    <span aria-hidden="true">{st.icon}</span>
                    {st.text}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium">{readinessLabel(c.id)}</p>
                    <p className="mt-0.5 text-sm break-words">{c.detail}</p>
                    <p className="mt-0.5 font-mono text-xs text-muted">{c.id}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
