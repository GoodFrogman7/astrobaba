import type { SafetyResources } from "@astro/shared";
import { telHref } from "@/lib/trust";

/**
 * Guidance for the astrologer after the `safety` event (trust.md §3): the client may be in
 * crisis. Calm, not dismissible, and placed next to where the astrologer types or talks. The
 * helplines come from `GET /v1/safety/resources` (data/safety/helplines.json), never from here.
 */
export function SafetyPanel({
  resources,
  failed = false,
  kind = "chat",
}: {
  resources: SafetyResources | null;
  failed?: boolean;
  kind?: "chat" | "call";
}) {
  const said = kind === "call" ? "said" : "wrote";
  return (
    <section
      aria-labelledby="safety-h"
      className="mt-4 rounded-md border-2 border-accent bg-surface p-4"
    >
      <h2 id="safety-h" role="alert" className="font-semibold">
        The client may be in crisis
      </h2>
      <p className="mt-1 text-sm">
        Something the client {said} suggests they may be thinking about harming themselves. Stay
        calm and kind, and listen.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
        <li>
          Share these helplines and encourage the client to call one now. They are shown on the
          client&apos;s screen too.
        </li>
        <li>
          Do not sell anything: no remedies, no products, no extra time. Recharge prompts are paused
          for this session.
        </li>
        <li>The client can end the session at any time. Do not try to keep them in it.</li>
        <li>You are not expected to counsel them. The helplines have trained people.</li>
      </ul>
      {resources ? (
        <ul className="mt-3 space-y-2" aria-label="Crisis helplines">
          {resources.helplines.map((h) => (
            <li key={h.id || h.number} className="rounded-sm border border-border bg-bg px-3 py-2">
              <a href={telHref(h.number)} className="text-lg font-semibold underline">
                {h.number}
              </a>
              <span className="block text-sm">{h.name.en}</span>
              {h.hours?.en && <span className="block text-xs text-muted">{h.hours.en}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">
          {failed
            ? "The helpline numbers could not be loaded. The client is shown them on their screen; ask them to use those numbers or local emergency services."
            : "Loading helpline numbers…"}
        </p>
      )}
    </section>
  );
}
