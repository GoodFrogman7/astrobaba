import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/ActionForm";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api, ApiError } from "@/lib/api";
import { adminPage } from "@/lib/guard";
import { formatRupees } from "@/lib/money";
import { canAct, canApprove, canReinstate, canReject, canSuspend, stepState } from "@/lib/steps";
import { STEPS, type AdminAstrologer, type Taxonomy } from "@/lib/types";
import {
  approve,
  recordStep,
  reinstate,
  reject,
  suspend,
  updateFlags,
  updateTierPrice,
} from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Astrologer" };

const STEP_LABEL = {
  identity: "Identity (government ID matches the applicant)",
  qualification: "Qualifications (certificates, training)",
  interview: "Panel interview",
  probation: "Probation (live, monitored; pass → approved, fail → rejected)",
} as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default async function AstrologerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { access, data } = await adminPage(async () => {
    try {
      const [a, taxonomy] = await Promise.all([
        api.get<AdminAstrologer>(`/v1/admin/astrologers/${encodeURIComponent(id)}`),
        api.get<Taxonomy>("/v1/taxonomy"),
      ]);
      return { a, taxonomy };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  });
  if (access.kind !== "admin") return <NotAuthorised />;
  if (!data) notFound();
  const { a, taxonomy } = data;
  const steps = stepState(a.verifications);
  const name = (list: { id: string; en: string }[], ids: string[]) =>
    ids.map((x) => list.find((i) => i.id === x)?.en ?? x).join(", ");
  const tierOptions = taxonomy.tiers.map((t) => (
    <option key={t.id} value={t.id}>
      {t.en} ({formatRupees(t.min_price_per_min_paise)}–{formatRupees(t.max_price_per_min_paise)})
    </option>
  ));
  const currentPrice = a.price_per_min_paise ?? a.requested_price_per_min_paise;

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <Link href={`/astrologers?status=${a.status}`} className="text-sm underline">
        ← Back to queue
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">
        {a.display_name}
        {a.is_seed && (
          <span className="ml-2 rounded-sm bg-accent px-1.5 py-0.5 align-middle text-xs text-accent-fg">
            demo
          </span>
        )}
      </h1>
      <p className="mt-1 text-sm text-muted">
        Status: <strong>{a.status}</strong> · Phone {a.phone ?? "–"} · Applied{" "}
        {a.created_at.slice(0, 10)}
        {a.slug && ` · /astrologers/${a.slug}`}
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="Profile">
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted">Skills</dt>
            <dd>{name(taxonomy.skills, a.skills)}</dd>
            <dt className="text-muted">Languages</dt>
            <dd>{name(taxonomy.languages, a.languages)}</dd>
            <dt className="text-muted">Gender</dt>
            <dd>{name(taxonomy.genders, [a.gender])}</dd>
            <dt className="text-muted">Experience</dt>
            <dd>{a.experience_years} years</dd>
            <dt className="text-muted">Requested price</dt>
            <dd>{formatRupees(a.requested_price_per_min_paise)}/min</dd>
            <dt className="text-muted">Approved price</dt>
            <dd>
              {a.price_per_min_paise ? `${formatRupees(a.price_per_min_paise)}/min` : "–"} · tier{" "}
              {a.tier ?? "–"}
            </dd>
          </dl>
          <h3 className="mt-4 text-sm font-semibold">Bio</h3>
          <p className="mt-1 whitespace-pre-line text-sm">{a.bio}</p>
          {a.bio_hi && (
            <p lang="hi" className="mt-2 whitespace-pre-line text-sm">
              {a.bio_hi}
            </p>
          )}
        </Section>

        <Section title="Documents">
          {a.documents.length === 0 ? (
            <p className="text-sm text-muted">No documents uploaded yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {a.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{d.kind}</strong> · {d.filename} · {Math.ceil(d.size / 1024)} KB ·{" "}
                    {d.uploaded_at.slice(0, 10)}
                  </span>
                  <a
                    href={`/documents/${d.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-sm border border-border px-2 py-1"
                  >
                    View
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">
            Opening a document is recorded in the audit log. Documents are never cached.
          </p>
        </Section>

        <Section title="Verification">
          <ol className="space-y-4">
            {STEPS.map((s, i) => {
              const v = steps[s];
              const actionable = canAct(s, a.verifications, a.status);
              return (
                <li key={s} className="text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium">
                      {i + 1}. {STEP_LABEL[s]}
                    </span>
                    <span
                      className={
                        v.status === "passed"
                          ? "text-success"
                          : v.status === "failed"
                            ? "text-danger"
                            : "text-muted"
                      }
                    >
                      {v.status}
                      {v.at ? ` · ${v.at.slice(0, 10)}` : ""}
                    </span>
                  </div>
                  {v.note && <p className="mt-1 text-muted">“{v.note}”</p>}
                  {actionable && (
                    <ActionForm
                      action={recordStep.bind(null, a.id, s)}
                      submitLabel="Record result"
                      className="mt-2"
                    >
                      <fieldset className="flex gap-4">
                        <legend className="sr-only">Result for {s}</legend>
                        <label className="flex items-center gap-1">
                          <input type="radio" name="status" value="passed" required /> Pass
                        </label>
                        <label className="flex items-center gap-1">
                          <input type="radio" name="status" value="failed" /> Fail
                        </label>
                      </fieldset>
                      <label className="block">
                        <span className="sr-only">Note for {s}</span>
                        <input
                          name="note"
                          placeholder="Note (required when failing)"
                          className="w-full rounded-sm border border-border bg-bg px-2 py-1"
                        />
                      </label>
                    </ActionForm>
                  )}
                </li>
              );
            })}
          </ol>
        </Section>

        <Section title="Decision">
          {canApprove(a.verifications, a.status) && (
            <ActionForm
              action={approve.bind(null, a.id)}
              submitLabel="Approve"
              confirm="Put this astrologer live on probation?"
              className="mb-6"
            >
              <p className="text-sm">
                Identity, qualifications and interview passed. Set tier and price:
              </p>
              <TierPrice options={tierOptions} tier={a.tier} price={currentPrice} />
            </ActionForm>
          )}
          {canSuspend(a.status) && (
            <ActionForm
              action={suspend.bind(null, a.id)}
              submitLabel="Suspend"
              confirm="Hide this astrologer everywhere?"
              destructive
              className="mb-4"
            >
              <Reason />
            </ActionForm>
          )}
          {canReinstate(a.status) && (
            <ActionForm
              action={reinstate.bind(null, a.id)}
              submitLabel="Reinstate"
              confirm="Make this astrologer public again?"
              className="mb-4"
            />
          )}
          {canReject(a.status) && (
            <ActionForm
              action={reject.bind(null, a.id)}
              submitLabel="Reject"
              confirm="Reject this application for good?"
              destructive
            >
              <Reason />
            </ActionForm>
          )}
          {a.suspended_reason && (
            <p className="mt-2 text-sm text-muted">Suspended: {a.suspended_reason}</p>
          )}
          {a.rejected_reason && (
            <p className="mt-2 text-sm text-muted">Rejected: {a.rejected_reason}</p>
          )}
        </Section>

        {(a.status === "probation" || a.status === "approved" || a.status === "suspended") && (
          <Section title="Tier, price and flags">
            <ActionForm
              action={updateTierPrice.bind(null, a.id)}
              submitLabel="Save tier and price"
              className="mb-6"
            >
              <TierPrice options={tierOptions} tier={a.tier} price={currentPrice} />
            </ActionForm>
            <ActionForm action={updateFlags.bind(null, a.id)} submitLabel="Save flags">
              {(["chat_enabled", "call_enabled", "show_in_directory"] as const).map((f) => (
                <label key={f} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={f} defaultChecked={a.flags[f]} />{" "}
                  {f.replaceAll("_", " ")}
                </label>
              ))}
            </ActionForm>
          </Section>
        )}

        <Section title="Audit trail">
          {a.audit.length === 0 ? (
            <p className="text-sm text-muted">No admin actions yet.</p>
          ) : (
            <ol className="space-y-1 text-sm">
              {a.audit.map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span className="text-muted">{e.at.replace("T", " ").slice(0, 16)}</span> ·{" "}
                  {e.actor} · <strong>{e.action}</strong>
                </li>
              ))}
            </ol>
          )}
        </Section>
      </div>
    </main>
  );
}

function TierPrice({
  options,
  tier,
  price,
}: {
  options: React.ReactNode;
  tier: string | null;
  price: number;
}) {
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      <label className="flex flex-col">
        Tier
        <select
          name="tier"
          defaultValue={tier ?? ""}
          required
          className="rounded-sm border border-border bg-bg px-2 py-1"
        >
          <option value="" disabled>
            Choose…
          </option>
          {options}
        </select>
      </label>
      <label className="flex flex-col">
        Price (₹ per minute)
        <input
          name="price_rupees"
          inputMode="decimal"
          defaultValue={(price / 100).toString()}
          required
          className="w-32 rounded-sm border border-border bg-bg px-2 py-1"
        />
      </label>
    </div>
  );
}

function Reason() {
  return (
    <label className="block text-sm">
      Reason (shown in the audit log)
      <textarea
        name="reason"
        required
        minLength={3}
        rows={2}
        className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
      />
    </label>
  );
}
