import {
  INVITE_STATUSES,
  type AstrologerInvite,
  type CoverageRow,
  type InviteStatus,
  type SupplyReadiness,
} from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/ActionForm";
import { LoadError } from "@/components/LoadError";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import {
  INVITE_STATUS_LABEL,
  PIPELINE_LABEL,
  PIPELINE_STATUSES,
  VERIFICATION_LABEL,
  VERIFICATION_STEPS,
  WEEKDAYS,
  coverageStatus,
  inviteStatusFilter,
  isCoreHour,
  languageName,
  scheduleGrid,
  skillName,
  supplyStatus,
} from "@/lib/growth-admin";
import { adminPage } from "@/lib/guard";
import { tryLoad } from "@/lib/load";
import { formatIst } from "@/lib/money-admin";
import { revokeInvite } from "./actions";
import { InviteCreateForm } from "./InviteCreateForm";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Supply" };

const th = "py-2 pr-4 font-medium";
const num = "py-2 pr-4 text-right tabular-nums";
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const UNCOVERED_PATTERN =
  "repeating-linear-gradient(135deg, var(--color-danger) 0 2px, transparent 2px 6px)";

function CoverageTable({
  title,
  rows,
  name,
}: {
  title: string;
  rows: CoverageRow[];
  name: (id: string) => string;
}) {
  return (
    <section aria-label={title} className="min-w-0">
      <h3 className="font-medium">{title}</h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No minimums set in targets.json.</p>
      ) : (
        <table className="mt-2 w-full text-left text-sm">
          <thead className="border-b border-border text-muted">
            <tr>
              <th scope="col" className={th}>
                {title.replace(" coverage", "")}
              </th>
              <th scope="col" className={`${th} text-right`}>
                Live
              </th>
              <th scope="col" className={`${th} text-right`}>
                Minimum
              </th>
              <th scope="col" className={th}>
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const short = r.target_min > 0 && r.live < r.target_min;
              return (
                <tr key={r.id} className="border-b border-border">
                  <th scope="row" className="py-2 pr-4 font-normal">
                    {name(r.id)}
                  </th>
                  <td className={num}>{r.live}</td>
                  <td className={num}>{r.target_min}</td>
                  <td className={`py-2 pr-4 ${short ? "font-medium text-danger" : ""}`}>
                    {coverageStatus(r)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function ScheduleTable({ grid, uncovered }: { grid: number[][]; uncovered: number }) {
  const max = Math.max(1, ...grid.flat());
  return (
    <>
      <p className="mt-2 text-sm">
        <span className="font-medium">{uncovered}</span> core hour{uncovered === 1 ? "" : "s"} with
        nobody scheduled.{" "}
        <span className="text-muted">
          Cells show live astrologers scheduled per IST hour. Uncovered core hours are striped and
          marked “!”; non-core hours are greyed.
        </span>
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="border-collapse text-center text-xs tabular-nums">
          <caption className="sr-only">
            Live astrologers scheduled per weekday and IST hour, Monday first
          </caption>
          <thead>
            <tr>
              <th scope="col" className="px-1 py-1 text-left font-medium text-muted">
                Day
              </th>
              {HOURS.map((h) => (
                <th key={h} scope="col" className="w-8 px-0.5 py-1 font-medium text-muted">
                  <span aria-label={`${String(h).padStart(2, "0")}:00`}>
                    {String(h).padStart(2, "0")}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, d) => (
              <tr key={WEEKDAYS[d]}>
                <th scope="row" className="px-1 py-1 text-left font-medium">
                  {WEEKDAYS[d]?.slice(0, 3)}
                </th>
                {row.map((n, h) => {
                  const core = isCoreHour(d, h);
                  const gap = core && n === 0;
                  return (
                    <td
                      key={h}
                      className={`h-8 border border-border px-0.5 ${
                        gap ? "font-semibold text-danger" : core ? "" : "text-muted"
                      }`}
                      style={
                        gap
                          ? { backgroundImage: UNCOVERED_PATTERN }
                          : n > 0
                            ? {
                                backgroundColor: `color-mix(in srgb, var(--color-primary) ${Math.round(
                                  10 + (n / max) * 40,
                                )}%, transparent)`,
                              }
                            : undefined
                      }
                    >
                      {n}
                      {gap && (
                        <>
                          <span aria-hidden="true">!</span>
                          <span className="sr-only"> (uncovered core hour)</span>
                        </>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function invitesHref(status: InviteStatus | null) {
  return status ? `/supply?invites=${status}#invites` : "/supply#invites";
}

/** Astrologer supply readiness and invites (growth.md §2). */
export default async function SupplyPage({
  searchParams,
}: {
  searchParams: Promise<{ invites?: string }>;
}) {
  const sp = await searchParams;
  const inviteStatus = inviteStatusFilter(sp.invites);
  const { access, data } = await adminPage(async () => {
    const [supply, invites] = await Promise.all([
      tryLoad(() => api.get<SupplyReadiness>("/v1/admin/growth/supply")),
      tryLoad(() =>
        api.get<{ items: AstrologerInvite[] }>(
          `/v1/admin/astrologer-invites${inviteStatus ? `?status=${inviteStatus}` : ""}`,
        ),
      ),
    ]);
    return { supply, invites };
  });
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  const s = data.supply.ok ? data.supply.value : null;
  const grid = s ? scheduleGrid(s.schedule?.hours) : null;
  const barMax = s ? Math.max(s.target.max, s.live) : 0;

  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Astrologer supply</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Live means approved and public; demo astrologers are never counted. Minimums come from
        data/growth/targets.json and are proposals until the founder confirms them.
      </p>

      {!data.supply.ok ? (
        <LoadError error={data.supply.error} />
      ) : (
        s && (
          <>
            <section aria-labelledby="live-h" className="mt-6">
              <h2 id="live-h" className="text-lg font-semibold">
                Live astrologers
              </h2>
              <p className="mt-2">
                <span className="text-3xl font-semibold tabular-nums">{s.live}</span>{" "}
                <span className="text-muted">
                  live · target {s.target.min}–{s.target.max}
                </span>
              </p>
              <p
                className={`mt-1 text-sm font-medium ${s.live < s.target.min ? "text-danger" : ""}`}
              >
                {supplyStatus(s.live, s.target)}
              </p>
              {barMax > 0 && (
                <div aria-hidden="true" className="relative mt-2 h-3 max-w-xl rounded-sm bg-bg">
                  <span
                    className="block h-3 rounded-sm bg-primary"
                    style={{ width: `${(s.live / barMax) * 100}%` }}
                  />
                  <span
                    className="absolute top-[-2px] h-4 w-0.5 bg-fg"
                    style={{ left: `${(s.target.min / barMax) * 100}%` }}
                  />
                </div>
              )}
            </section>

            <div className="mt-8 grid gap-8 lg:grid-cols-2">
              <section aria-labelledby="pipeline-h">
                <h2 id="pipeline-h" className="text-lg font-semibold">
                  Pipeline
                </h2>
                <table className="mt-2 w-full text-left text-sm">
                  <thead className="border-b border-border text-muted">
                    <tr>
                      <th scope="col" className={th}>
                        Status
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        Astrologers
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {PIPELINE_STATUSES.map((st) => (
                      <tr key={st} className="border-b border-border">
                        <th scope="row" className="py-2 pr-4 font-normal">
                          <Link
                            href={`/astrologers?status=${st}`}
                            prefetch={false}
                            className="underline"
                          >
                            {PIPELINE_LABEL[st]}
                          </Link>
                        </th>
                        <td className={num}>{s.pipeline[st] ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
              <section aria-labelledby="steps-h">
                <h2 id="steps-h" className="text-lg font-semibold">
                  Verification steps passed
                </h2>
                <table className="mt-2 w-full text-left text-sm">
                  <thead className="border-b border-border text-muted">
                    <tr>
                      <th scope="col" className={th}>
                        Step
                      </th>
                      <th scope="col" className={`${th} text-right`}>
                        Passed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {VERIFICATION_STEPS.map((st) => (
                      <tr key={st} className="border-b border-border">
                        <th scope="row" className="py-2 pr-4 font-normal">
                          {VERIFICATION_LABEL[st]}
                        </th>
                        <td className={num}>{s.steps_passed[st] ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </div>

            <section aria-labelledby="coverage-h" className="mt-8">
              <h2 id="coverage-h" className="text-lg font-semibold">
                Coverage (live astrologers)
              </h2>
              <div className="mt-2 grid gap-8 lg:grid-cols-2">
                <CoverageTable title="Language coverage" rows={s.languages} name={languageName} />
                <CoverageTable title="Skill coverage" rows={s.skills} name={skillName} />
              </div>
            </section>

            <section aria-labelledby="schedule-h" className="mt-8">
              <h2 id="schedule-h" className="text-lg font-semibold">
                Weekly schedule (IST)
              </h2>
              {grid ? (
                <ScheduleTable grid={grid} uncovered={s.schedule.uncovered_hours} />
              ) : (
                <p role="alert" className="mt-2 text-sm text-danger">
                  The schedule could not be shown: the API did not return 7 days of 24 hours.
                </p>
              )}
            </section>
          </>
        )
      )}

      <section id="invites" aria-labelledby="invites-h" className="mt-10">
        <h2 id="invites-h" className="text-lg font-semibold">
          Invites
        </h2>
        {s && (
          <p className="mt-1 text-sm text-muted">
            {INVITE_STATUSES.map((st) => `${s.invites[st] ?? "—"} ${st}`).join(" · ")}
          </p>
        )}
        <div className="mt-4 rounded-md border border-border bg-surface p-4">
          <h3 className="mb-3 font-medium">Create an invite</h3>
          <InviteCreateForm />
        </div>

        <nav aria-label="Invite status" className="mt-6 overflow-x-auto">
          <ul className="flex gap-1 text-sm">
            {[null, ...INVITE_STATUSES].map((st) => (
              <li key={st ?? "all"}>
                <Link
                  href={invitesHref(st)}
                  prefetch={false}
                  aria-current={st === inviteStatus ? "page" : undefined}
                  className={`inline-block rounded-sm px-3 py-1.5 whitespace-nowrap ${
                    st === inviteStatus ? "bg-primary text-primary-fg" : "border border-border"
                  }`}
                >
                  {st ? INVITE_STATUS_LABEL[st] : "All"}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        {!data.invites.ok ? (
          <LoadError error={data.invites.error} />
        ) : data.invites.value.items.length === 0 ? (
          <p className="mt-4 text-muted">
            No {inviteStatus ? INVITE_STATUS_LABEL[inviteStatus].toLowerCase() : ""} invites.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-muted">
                <tr>
                  <th scope="col" className={th}>
                    Created (IST)
                  </th>
                  <th scope="col" className={th}>
                    Expires (IST)
                  </th>
                  <th scope="col" className={th}>
                    Status
                  </th>
                  <th scope="col" className={th}>
                    Note
                  </th>
                  <th scope="col" className={th}>
                    Used
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.invites.value.items.map((i) => (
                  <tr key={i.id} className="border-b border-border align-top">
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIst(i.created_at)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatIst(i.expires_at)}</td>
                    <td className="py-2 pr-4">{INVITE_STATUS_LABEL[i.status] ?? i.status}</td>
                    <td className="py-2 pr-4 break-words">{i.note ?? "–"}</td>
                    <td className="py-2 pr-4">
                      {i.used_at ? formatIst(i.used_at) : "–"}
                      {i.astrologer_id && (
                        <Link
                          href={`/astrologers/${encodeURIComponent(i.astrologer_id)}`}
                          prefetch={false}
                          className="block underline"
                        >
                          View astrologer
                        </Link>
                      )}
                    </td>
                    <td className="py-2">
                      {i.status === "open" && (
                        <ActionForm
                          action={revokeInvite.bind(null, i.id)}
                          submitLabel="Revoke"
                          confirm="Revoke this invite? Its code will stop working."
                          destructive
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
