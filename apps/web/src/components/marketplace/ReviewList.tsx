import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { shortDate } from "@/lib/marketplace/format";
import type { Rating, Review } from "@/lib/marketplace/types";
import { ReportReview } from "./ReportReview";

export function ReviewList({
  slug,
  name,
  reviews,
  rating,
  nextCursor,
}: {
  slug: string;
  name: string;
  reviews: Review[];
  rating: Rating;
  nextCursor: string | null;
}) {
  const t = useTranslations("market.profile");
  const locale = useLocale() as "en" | "hi";
  return (
    <section aria-labelledby="reviews" data-testid="reviews">
      <h2 id="reviews" className="text-xl font-semibold">
        {t("reviews")}
      </h2>
      {rating.count > 0 && rating.average !== null ? (
        <p className="mt-1 text-sm text-muted">
          {t("rating", { avg: rating.average.toFixed(1), count: rating.count })} ·{" "}
          {t("reviewsOnly")}
        </p>
      ) : (
        <p className="mt-2 text-muted">{t("noReviews")}</p>
      )}
      <ul className="mt-4 space-y-4">
        {reviews.map((r) => (
          <li key={r.id} className="rounded-md border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                <span aria-label={t("stars", { rating: r.rating })} role="img">
                  {"★".repeat(r.rating)}
                  <span className="text-muted">{"★".repeat(5 - r.rating)}</span>
                </span>{" "}
                <span className="text-muted">
                  {r.author_label} · {shortDate(r.created_at, locale)}
                </span>
              </span>
              <ReportReview id={r.id} />
            </div>
            <p className="mt-2 whitespace-pre-line leading-relaxed">{r.text}</p>
            {r.reply && (
              <div className="mt-3 border-l-2 border-border pl-3 text-sm">
                <p className="font-medium">{t("reply", { name })}</p>
                <p className="mt-1 whitespace-pre-line text-muted">{r.reply.text}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      {nextCursor && (
        <Link
          href={{ pathname: `/astrologers/${slug}`, query: { reviews: nextCursor } }}
          className="mt-4 inline-block py-2 font-medium text-accent underline"
          rel="nofollow"
        >
          {t("moreReviews")}
        </Link>
      )}
    </section>
  );
}
