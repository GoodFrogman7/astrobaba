import { useTranslations } from "next-intl";
import type { Presence as P } from "@/lib/marketplace/types";

const DOT: Record<P, string> = {
  online: "var(--color-success)",
  busy: "var(--color-accent)",
  offline: "var(--color-muted)",
};

/** Presence comes from the API (Redis heartbeat); wait time only when the API knows it. */
export function PresenceBadge({ presence, wait }: { presence: P; wait: number | null }) {
  const t = useTranslations("market.presence");
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 text-sm">
      <span className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: DOT[presence] }}
        />
        {t(presence)}
      </span>
      {presence === "busy" && wait !== null && (
        <span className="text-muted">{t("wait", { minutes: wait })}</span>
      )}
    </span>
  );
}
