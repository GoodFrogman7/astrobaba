import { useLocale, useTranslations } from "next-intl";
import { availabilityRows } from "@/lib/marketplace/availability";
import type { AstrologerProfile } from "@/lib/marketplace/types";

/**
 * "Usually available": the astrologer's weekly schedule in IST, rendered on the server with the
 * profile (no client fetch, no layout shift). Nothing at all when there are no slots. It is a
 * usual schedule, not a promise: live presence is the badge above.
 */
export function AvailabilityList({ p }: { p: AstrologerProfile }) {
  const t = useTranslations("market.profile.availability");
  const locale = useLocale() as "en" | "hi";
  const rows = availabilityRows(p.availability, locale, {
    range: (from, to) => t("range", { from, to }),
    pair: (a, b) => t("pair", { a, b }),
  });
  if (rows.length === 0) return null;
  return (
    <div className="mt-4" data-testid="availability">
      <h2 className="text-sm font-medium">{t("title")}</h2>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
        {rows.map((r) => (
          <div key={r.days} className="contents">
            <dt className="text-muted">
              <span aria-hidden="true">{r.days}</span>
              <span className="sr-only">{r.daysLong}</span>
            </dt>
            <dd className="tabular-nums">{r.times}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1 text-xs text-muted">{t("note")}</p>
    </div>
  );
}
