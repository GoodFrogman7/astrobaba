import type { ConsentState } from "@astro/shared";
import type { Metadata } from "next";
import Link from "next/link";
import { ConductRules } from "@/components/ConductRules";
import { TermsGatePage } from "@/components/TermsGatePage";
import { tryGet } from "@/lib/api";
import { formatIst } from "@/lib/format";
import { consolePage } from "@/lib/guard";
import { publicSiteUrl } from "@/lib/site";
import { acceptedAt, needsAstrologerTerms, safeNext } from "@/lib/trust";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Astrologer terms" };

/**
 * The astrologer terms gate as its own page. Pages that get `403 consent_required` from a
 * portal write send the astrologer here with `?next=` so they come back after accepting.
 */
export default async function TermsPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? safeNext(sp.next) : null;
  const page = await consolePage(() => tryGet<ConsentState>("/v1/me/consents"), { terms: false });
  if (!page.live) return page.notice;
  const consents = page.data;
  if (!consents.ok) {
    return (
      <main id="main" className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-semibold">Astrologer terms</h1>
        <p role="alert" className="mt-4 text-sm text-danger">
          Could not load your consent record: {consents.error}. Reload the page to try again.
        </p>
      </main>
    );
  }
  const state = consents.value;
  if (needsAstrologerTerms(state)) return <TermsGatePage version={state.version} next={next} />;
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Astrologer terms</h1>
      <p className="mt-3">
        You accepted the current astrologer terms (version {state.version}) on{" "}
        {formatIst(acceptedAt(state))} IST.
      </p>
      <p className="mt-2">
        <a
          href={`${publicSiteUrl()}/terms`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Read the full terms on the public site (opens in a new tab)
        </a>
      </p>
      <div className="mt-6">
        <ConductRules />
      </div>
      <Link href={next ?? "/"} className="mt-6 inline-block underline">
        {next && next !== "/" ? "Go back" : "Back to the console"}
      </Link>
    </main>
  );
}
