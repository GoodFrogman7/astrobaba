import { publicSiteUrl } from "@/lib/site";
import { ConductRules } from "./ConductRules";
import { TermsGate } from "./TermsGate";

/** Shown instead of a console page until the current astrologer terms are accepted. */
export function TermsGatePage({ version, next }: { version: string; next?: string | null }) {
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Astrologer terms</h1>
      <p className="mt-3">
        Before you use the console, please read and accept the current astrologer terms (version{" "}
        {version}). Until then you can&apos;t go online, accept requests or change your settings.
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
      <TermsGate version={version} next={next} />
    </main>
  );
}
