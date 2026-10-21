import type { Metadata } from "next";
import { cookies } from "next/headers";
import { ActionForm } from "@/components/ActionForm";
import { NotAuthorised } from "@/components/NotAuthorised";
import { api } from "@/lib/api";
import { REVIEWER_COOKIE } from "@/lib/cookies";
import { adminPage } from "@/lib/guard";
import { AREAS, type HoroscopeEntry } from "@/lib/types";
import { approveHoroscope, rejectHoroscope } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Horoscopes" };

/** Group the queue by sign/period/window so both locales of one horoscope sit together. */
function groups(entries: HoroscopeEntry[]) {
  const map = new Map<string, HoroscopeEntry[]>();
  for (const e of entries) {
    const key = `${e.window.start_ist_date} · ${e.period} · ${e.sign}`;
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  return [...map.entries()];
}

export default async function HoroscopesPage() {
  const reviewerName = (await cookies()).get(REVIEWER_COOKIE)?.value ?? "";
  const { access, data } = await adminPage(() =>
    api.get<HoroscopeEntry[]>("/v1/admin/horoscopes?status=pending_review&limit=100"),
  );
  if (access.kind !== "admin" || !data) return <NotAuthorised />;
  return (
    <main id="main" className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Horoscope review</h1>
      <p className="mt-2 max-w-3xl text-sm text-muted">
        AI-written text waits here until a person approves it (ADR-0005). Check every sentence
        against the computed facts on the left: no positions that are not there, no fear, no
        promises, no medical, legal or financial advice. Edits are re-validated before publishing.
      </p>
      {data.length === 0 && <p className="mt-8 text-muted">Nothing waiting for review.</p>}
      <div className="mt-6 space-y-10">
        {groups(data).map(([key, entries]) => (
          <section
            key={key}
            aria-label={key}
            className="rounded-md border border-border bg-surface p-5"
          >
            <h2 className="text-lg font-semibold capitalize">{key}</h2>
            <div className="mt-4 grid gap-6 lg:grid-cols-[18rem_1fr]">
              <Facts entry={entries[0]!} />
              <div className="space-y-8">
                {entries.map((e) => (
                  <article key={e.id} lang={e.locale} aria-label={`${e.locale} text`}>
                    <h3 className="text-sm font-semibold uppercase text-muted">
                      {e.locale} · {e.model} · prompt {e.prompt_version}
                    </h3>
                    <ActionForm
                      action={approveHoroscope.bind(null, e.id, e.sections)}
                      submitLabel="Approve and publish"
                      className="mt-2"
                    >
                      {AREAS.map((a) => (
                        <label key={a} className="block text-sm">
                          <span className="font-medium capitalize">
                            {a}
                            {e.scores?.[a] && (
                              <span className="ml-2 font-normal text-muted">
                                score {e.scores[a].score}/5 · {e.scores[a].label}
                              </span>
                            )}
                          </span>
                          <textarea
                            name={a}
                            defaultValue={e.sections[a]}
                            rows={4}
                            className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
                          />
                        </label>
                      ))}
                      <Reviewer value={reviewerName} />
                    </ActionForm>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm">Reject…</summary>
                      <ActionForm
                        action={rejectHoroscope.bind(null, e.id)}
                        submitLabel="Reject"
                        confirm="Reject this text?"
                        destructive
                        className="mt-2"
                      >
                        <label className="block text-sm">
                          Reason
                          <input
                            name="reason"
                            required
                            minLength={3}
                            className="mt-1 w-full rounded-sm border border-border bg-bg px-2 py-1"
                          />
                        </label>
                        <Reviewer value={reviewerName} />
                      </ActionForm>
                    </details>
                  </article>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

function Reviewer({ value }: { value: string }) {
  return (
    <label className="block text-sm">
      Reviewer name
      <input
        name="reviewer"
        defaultValue={value}
        required
        minLength={2}
        className="mt-1 w-56 rounded-sm border border-border bg-bg px-2 py-1"
      />
    </label>
  );
}

function Facts({ entry }: { entry: HoroscopeEntry }) {
  const transits = entry.facts?.transits ?? [];
  const areas = entry.facts?.areas ?? entry.scores ?? {};
  return (
    <aside className="text-sm">
      <h3 className="font-semibold">Computed facts</h3>
      <p className="text-muted">
        {entry.window.start_ist_date}
        {entry.window.end_ist_date !== entry.window.start_ist_date &&
          ` → ${entry.window.end_ist_date}`}
      </p>
      <table className="mt-2 w-full">
        <caption className="sr-only">Positions counted from {entry.sign}</caption>
        <thead>
          <tr className="text-left text-muted">
            <th scope="col">Graha</th>
            <th scope="col">Sign</th>
            <th scope="col">House</th>
          </tr>
        </thead>
        <tbody>
          {transits.map((t) => (
            <tr key={t.graha}>
              <td className="capitalize">
                {t.graha}
                {t.retrograde ? " (R)" : ""}
              </td>
              <td className="capitalize">{t.sign}</td>
              <td>{t.house_from_sign}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3 className="mt-4 font-semibold">Scores</h3>
      <ul>
        {Object.entries(areas).map(([a, s]) => (
          <li key={a} className="capitalize">
            {a}: {s.score}/5 · {s.label}
          </li>
        ))}
      </ul>
      {entry.lucky && (
        <p className="mt-2 text-muted">
          Lucky day {entry.lucky.day}, number {entry.lucky.number}
        </p>
      )}
    </aside>
  );
}
