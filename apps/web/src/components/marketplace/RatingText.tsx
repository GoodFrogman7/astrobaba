import { useTranslations } from "next-intl";
import type { Rating } from "@/lib/marketplace/types";

export function RatingText({ rating }: { rating: Rating }) {
  const t = useTranslations("market.card");
  if (rating.average === null || rating.count === 0)
    return <span className="text-sm text-muted">{t("new")}</span>;
  return (
    <span className="text-sm">
      <span aria-hidden="true">★ </span>
      <span className="font-medium">{rating.average.toFixed(1)}</span>{" "}
      <span className="text-muted">({t("reviews", { count: rating.count })})</span>
    </span>
  );
}
