import { CONDUCT_ENFORCEMENT, CONDUCT_RULES } from "@/lib/trust";

/** The banned-topic list (trust.md §3–§4), shown on the terms gate and the Conduct page. */
export function ConductRules({ headingLevel = 2 }: { headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby="conduct-rules-h">
      <H id="conduct-rules-h" className="text-lg font-semibold">
        Conduct rules
      </H>
      <ol className="mt-3 space-y-3">
        {CONDUCT_RULES.map((r) => (
          <li key={r.id} className="rounded-md border border-border bg-surface p-4">
            <p className="font-medium">{r.title}</p>
            <p className="mt-1 text-sm">{r.text}</p>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-sm text-muted">{CONDUCT_ENFORCEMENT}</p>
    </section>
  );
}
