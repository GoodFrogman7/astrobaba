import { AI_LABEL, type Locale } from "@astro/shared";

/**
 * The "AI" label on every AI surface (PLAN.md §6). A text badge, never an avatar or a person's
 * name, so an answer can never be mistaken for a human astrologer's.
 */
export function AiLabel({ locale, className = "" }: { locale: Locale; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border border-border px-2 py-0.5 text-xs font-semibold ${className}`}
      data-testid="ai-label"
    >
      <span aria-hidden="true" className="rounded-sm bg-fg px-1 font-mono text-[0.65rem] text-bg">
        AI
      </span>
      {AI_LABEL[locale]}
    </span>
  );
}
