import { useTranslations } from "next-intl";
import { ratingText } from "@/lib/marketplace/format";
import type { Rating } from "@/lib/marketplace/types";

export function RatingText({ rating }: { rating: Rating }) {
  const t = useTranslations("market.card");
  const avg = ratingText(rating.average);
  if (avg === null || rating.count === 0)
    return <span className="text-sm text-muted">{t("new")}</span>;
  return (
    <span className="text-sm">
      <span aria-hidden="true">★ </span>
      <span className="font-medium">{avg}</span>{" "}
      <span className="text-muted">({t("reviews", { count: rating.count })})</span>
    </span>
  );
}
