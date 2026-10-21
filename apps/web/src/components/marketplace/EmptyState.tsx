import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";

/** Shown when no astrologer is public yet (production today): honest, no invented numbers. */
export function EmptyState() {
  const t = useTranslations("market.directory");
  return (
    <section
      aria-labelledby="empty"
      className="rounded-md border border-border bg-surface p-6"
      data-testid="empty-state"
    >
      <h2 id="empty" className="text-lg font-semibold">
        {t("emptyTitle")}
      </h2>
      <p className="mt-2 max-w-2xl leading-relaxed text-muted">{t("emptyBody")}</p>
      <Link
        href="/astrologers/apply"
        className="mt-3 inline-block py-1 font-medium text-accent underline"
      >
        {t("emptyApply")}
      </Link>
    </section>
  );
}
