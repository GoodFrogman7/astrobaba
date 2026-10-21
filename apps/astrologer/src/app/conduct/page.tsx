import type { Metadata } from "next";
import Link from "next/link";
import { ConductRules } from "@/components/ConductRules";
import { tryGet } from "@/lib/api";
import { formatIst } from "@/lib/format";
import { consolePage } from "@/lib/guard";
import { normalizeStrikes, strikeReasonLabel } from "@/lib/trust";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Conduct" };

/** Conduct rules and the astrologer's own strikes (trust.md §4). */
export default async function ConductPage() {
  const page = await consolePage(() => tryGet<unknown>("/v1/astrologer/me/strikes"));
  if (!page.live) return page.notice;
  const strikes = page.data.ok ? normalizeStrikes(page.data.value) : null;
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Conduct</h1>
      <p className="mt-2 text-sm text-muted">
        These rules protect clients and you. They are part of the{" "}
        <Link href="/terms" className="underline">
          astrologer terms
        </Link>{" "}
        you accepted.
      </p>
      <div className="mt-6">
        <ConductRules />
      </div>

      <section aria-labelledby="strikes-h" className="mt-8">
        <h2 id="strikes-h" className="text-lg font-semibold">
          Your strikes
        </h2>
        <p className="mt-1 text-sm text-muted">
          A strike is a warning recorded by our moderation team after a client report or a refused
          message. Contact support if you think one is wrong.
        </p>
        {strikes === null ? (
          <p role="alert" className="mt-3 text-sm text-danger">
            Could not load your strikes: {!page.data.ok && page.data.error}. Reload the page to try
            again.
          </p>
        ) : strikes.length === 0 ? (
          <p className="mt-3">No strikes. Thank you for following the rules.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {strikes.map((s) => (
              <li key={s.id} className="rounded-md border border-border p-4">
                <p className="flex flex-wrap justify-between gap-2">
                  <span className="font-medium">{strikeReasonLabel(s.reason)}</span>
                  <span className="text-sm text-muted">{formatIst(s.at)} IST</span>
                </p>
                {s.note && <p className="mt-1 text-sm">{s.note}</p>}
                {s.session_id && (
                  <p className="mt-1 font-mono text-xs text-muted">Session {s.session_id}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
