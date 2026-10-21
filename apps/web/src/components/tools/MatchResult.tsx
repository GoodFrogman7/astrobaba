"use client";

import { useTranslations } from "next-intl";
import type { Match } from "@/lib/tools/types";
import { useAstroNames } from "./names";
import { Card, PendingReview } from "./Results";

/** Score band for the neutral summary (thresholds 18 and 25 out of 36, as commonly used). */
export function band(total: number): "low" | "mid" | "high" {
  if (total < 18) return "low";
  if (total < 25) return "mid";
  return "high";
}

export function MatchResult({ match }: { match: Match }) {
  const t = useTranslations("toolsUi.match");
  const tr = useTranslations("toolsUi.result");
  const tf = useTranslations("toolsUi.form");
  const n = useAstroNames();
  const partners = [
    { label: tf("partner1"), side: match.groom },
    { label: tf("partner2"), side: match.bride },
  ];
  return (
    <div className="space-y-6">
      <Card title={t("summary")}>
        <p className="text-3xl font-semibold">
          {t("total", { total: match.total, max: match.max })}
        </p>
        <p>{t(`bands.${band(match.total)}`)}</p>
        <ul className="text-sm text-muted">
          {partners.map((p) => (
            <li key={p.label}>
              {p.label}: {n.sign(p.side.moon.sign)}, {n.nakshatra(p.side.moon.nakshatra)}
            </li>
          ))}
        </ul>
        <PendingReview status={match.tables_review_status} />
      </Card>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1 pr-3">
                {t("koota")}
              </th>
              <th scope="col" className="py-1 pr-3">
                {t("measures")}
              </th>
              <th scope="col" className="py-1 text-right">
                {t("points")}
              </th>
            </tr>
          </thead>
          <tbody>
            {match.kootas.map((k) => (
              <tr key={k.koota} className="border-b border-border">
                <td className="py-1 pr-3 font-medium">
                  {t.has(`kootaName.${k.koota}`) ? t(`kootaName.${k.koota}`) : k.koota}
                </td>
                <td className="py-1 pr-3">
                  {t.has(`kootaInfo.${k.koota}`) ? t(`kootaInfo.${k.koota}`) : ""}
                </td>
                <td className="py-1 text-right font-mono">
                  {k.points} / {k.max}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Card title={tr("doshas")}>
        {match.doshas.nadi && <p>{t("nadiDosha")}</p>}
        {match.doshas.bhakoot && <p>{t("bhakootDosha")}</p>}
        {!match.doshas.nadi && !match.doshas.bhakoot && <p>{t("noDosha")}</p>}
        {partners.map((p) => (
          <p key={p.label}>
            {t("partnerMangal", {
              partner: p.label,
              state: p.side.mangal_dosha.present ? tr("present") : tr("notPresent"),
            })}
          </p>
        ))}
        <p className="text-sm text-muted">{t("convention")}</p>
      </Card>
      <Card title={t("remediesHeading")}>
        {(t.raw("remedies") as string[]).map((r) => (
          <p key={r.slice(0, 30)}>{r}</p>
        ))}
      </Card>
    </div>
  );
}
