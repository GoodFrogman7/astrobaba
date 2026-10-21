import type { Locale } from "@astro/shared";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";

/**
 * The small "not a helpline" line every consultation page carries (docs/api/trust.md §3),
 * linking to the crisis resources. The entertainment disclaimer sits next to it in the room
 * and in the footer.
 */
export async function SafetyNotice({ locale }: { locale: Locale }) {
  const t = await getTranslations({ locale, namespace: "trust.safety" });
  return (
    <p className="text-sm text-muted" data-testid="safety-notice">
      {t("notice")}{" "}
      <Link href="/safety" className="text-accent underline">
        {t("noticeLink")}
      </Link>
    </p>
  );
}
