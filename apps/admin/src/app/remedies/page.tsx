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
  LEAD_NOTE_MAX,
  LEAD_STATUSES,
  LEAD_STATUS_LABEL,
  LEAD_TARGETS,
  leadStatusFilter,
  safePhone,
  type AdminLead,
} from "@/lib/remedies";
import type { Page } from "@/lib/types";
import { updateLead } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Remedy leads" };

const TABS = [null, ...LEAD_STATUSES] as const;

function href(status: string | null, cursor?: string) {
  const p = new URLSearchParams();
  if (status) p.set("status", status);
  if (cursor) p.set("cursor", cursor);
  const q = p.toString();
  return q ? `/remedies?${q}` : "/remedies";
}

export default async function RemedyLeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const status = leadStatusFilter(sp.status);
  const cursor = typeof sp.cursor === "string" ? sp.cursor.slice(0, 200) : "";
  const { access, data } = await adminPage(() =>
    tryLoad(() => {
      const params = new URLSearchParams({ limit: "25" });
      if (status) params.set("status", status);
      if (cursor) params.set("cursor", cursor);
      return api.get<Page<AdminLead>>(`/v1/admin/remedies/leads?${params}`);
    }),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Remedy leads</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Enquiries passed to partners. We sell nothing ourselves and promise no outcome. Phone
        numbers are masked here; the full number and the user&apos;s note go to the partner only.
      </p>
      <nav aria-label="Lead status" className="mt-4 overflow-x-auto">
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
                {t ? LEAD_STATUS_LABEL[t] : "All"}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {!data.ok ? (
        <LoadError error={data.error} />
      ) : data.value.items.length === 0 ? (
        <p className="mt-8 text-muted">
          No {status ? LEAD_STATUS_LABEL[status].toLowerCase() : ""} leads.
        </p>
      ) : (
        <ul className="mt-6 space-y-4">
          {data.value.items.map((lead) => (
            <li key={lead.id} className="rounded-md border border-border bg-surface p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="font-medium">{lead.remedy_name?.en ?? lead.remedy_id}</h2>
                <span className="text-sm">
                  <span className="rounded-sm border border-border px-2 py-0.5">
                    {LEAD_STATUS_LABEL[lead.status]}
                  </span>
                </span>
              </div>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="inline text-muted">Received: </dt>
                  <dd className="inline">{formatIst(lead.created_at)}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">Phone: </dt>
                  <dd className="inline tabular-nums">{safePhone(lead.phone_masked)}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">Language: </dt>
                  <dd className="inline">{lead.language === "hi" ? "Hindi" : "English"}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">Preferred date: </dt>
                  <dd className="inline">{lead.preferred_date ?? "No preference"}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">Partner: </dt>
                  <dd className="inline">{lead.partner_id}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">Sent to partner: </dt>
                  <dd className="inline">
                    {lead.notified_at ? formatIst(lead.notified_at) : "Not yet"}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-muted">Note from user: </dt>
                  <dd className="inline">{lead.has_note ? "Yes (partner only)" : "None"}</dd>
                </div>
                <div>
                  <dt className="inline text-muted">User: </dt>
                  <dd className="inline font-mono text-xs">{lead.user_id}</dd>
                </div>
              </dl>
              {lead.admin_note && (
                <p className="mt-2 border-l-2 border-border pl-3 text-sm text-muted">
                  Admin note ({formatIst(lead.status_changed_at)}): {lead.admin_note}
                </p>
              )}
              <details className="mt-3">
                <summary className="cursor-pointer text-sm underline">Update status</summary>
                <ActionForm
                  action={updateLead.bind(null, lead.id)}
                  submitLabel="Save"
                  className="mt-3 max-w-xl"
                >
                  <fieldset>
                    <legend className="text-sm">Status</legend>
                    <div className="mt-1 flex flex-wrap gap-4 text-sm">
                      {LEAD_TARGETS.map((t) => (
                        <label key={t} className="inline-flex items-center gap-1.5">
                          <input
                            type="radio"
                            name="status"
                            value={t}
                            required
                            defaultChecked={t === lead.status}
                          />
                          {LEAD_STATUS_LABEL[t]}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <label className="block text-sm">
                    Note (optional, visible to admins; do not paste phone numbers)
                    <textarea
                      name="note"
                      rows={2}
                      maxLength={LEAD_NOTE_MAX}
                      defaultValue={lead.admin_note ?? ""}
                      className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
                    />
                  </label>
                </ActionForm>
              </details>
            </li>
          ))}
        </ul>
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
