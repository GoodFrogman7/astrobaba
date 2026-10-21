import type { ConsultSettings } from "@astro/shared";
import type { Metadata } from "next";
import { api, tryGet } from "@/lib/api";
import { tierLabel } from "@/lib/consult";
import { formatRate } from "@/lib/format";
import { consolePage } from "@/lib/guard";
import type { AstrologerProfile } from "@/lib/types";
import { ConsultToggles } from "./ConsultToggles";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const page = await consolePage(async () => {
    const [consult, profile] = await Promise.all([
      tryGet<ConsultSettings>("/v1/astrologer/me/consult"),
      api.get<AstrologerProfile>("/v1/astrologer/me").catch(() => null),
    ]);
    return { consult, profile };
  });
  if (!page.live) return page.notice;
  const { consult, profile } = page.data;
  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section
        aria-labelledby="consult-h"
        className="mt-6 rounded-md border border-border bg-surface p-5"
      >
        <h2 id="consult-h" className="text-lg font-semibold">
          Consultation types
        </h2>
        <p className="mt-1 text-sm text-muted">
          Choose how clients can reach you. Changes apply to new requests; a consultation in
          progress is not affected. Every change is recorded.
        </p>
        {consult.ok ? (
          <ConsultToggles initial={consult.value} />
        ) : (
          <p role="alert" className="mt-4 text-sm text-danger">
            Could not load your settings: {consult.error}. Reload the page to try again.
          </p>
        )}
      </section>

      <section aria-labelledby="price-h" className="mt-6 rounded-md border border-border p-5">
        <h2 id="price-h" className="text-lg font-semibold">
          Price and tier
        </h2>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted">Price</dt>
          <dd>
            {typeof profile?.price_per_min_paise === "number"
              ? formatRate(profile.price_per_min_paise)
              : "Not available"}
            <span className="text-muted"> (the same for chat and calls)</span>
          </dd>
          <dt className="text-muted">Tier</dt>
          <dd>{profile ? tierLabel(profile.tier) : "Not available"}</dd>
        </dl>
        <p className="mt-3 text-sm text-muted">
          Set by the platform. Your price and tier, and the platform&apos;s commission for your
          tier, can only be changed by our team. Contact support if you think they should change.
        </p>
      </section>
    </main>
  );
}
