import { useTranslations } from "next-intl";

export function DemoBadge() {
  const t = useTranslations("market.card");
  return (
    <span className="rounded-sm border border-accent px-1.5 py-0.5 text-xs font-medium text-accent">
      {t("demo")}
    </span>
  );
}
