"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { NorthIndianChart, SouthIndianChart, type ChartLocale } from "@/components/charts";
import type { ActionResult, BirthInput, Dasha, Doshas, Kundli } from "@/lib/tools/types";
import { useAstroNames } from "./names";
import {
  DashaResult,
  KaalSarpResult,
  MangalResult,
  SadeSatiResult,
  UnknownTimeNote,
} from "./Results";
import { SaveKundli } from "./SaveKundli";

export function ChartToggle({ kundli }: { kundli: Kundli }) {
  const t = useTranslations("toolsUi.result");
  const locale = useLocale() as ChartLocale;
  const [style, setStyle] = useState<"north" | "south">("north");
  return (
    <div>
      <div role="radiogroup" aria-label={t("chartStyle")} className="mb-3 flex gap-2 text-sm">
        {(["north", "south"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={style === s}
            onClick={() => setStyle(s)}
            className={`rounded-sm border px-3 py-1 ${style === s ? "border-primary bg-primary text-primary-fg" : "border-border"}`}
          >
            {t(s)}
          </button>
        ))}
      </div>
      <div className="mx-auto max-w-md">
        {style === "north" ? (
          <NorthIndianChart data={kundli} locale={locale} />
        ) : (
          <SouthIndianChart data={kundli} locale={locale} />
        )}
      </div>
    </div>
  );
}

export function PlanetsTable({ kundli }: { kundli: Kundli }) {
  const t = useTranslations("toolsUi.result");
  const n = useAstroNames();
  const known = kundli.ascendant !== null;
  const cell = "py-1 pr-2 sm:pr-3";
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs sm:text-sm">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={cell}>
              {t("graha")}
            </th>
            <th scope="col" className={cell}>
              {t("sign")}
            </th>
            <th scope="col" className={cell}>
              {t("degree")}
            </th>
            <th scope="col" className={cell}>
              {t("nakshatraPada")}
            </th>
            {known && (
              <th scope="col" className="py-1">
                {t("house")}
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {kundli.ascendant && (
            <tr className="border-b border-border font-medium">
              <td className={cell}>{t("ascendant")}</td>
              <td className={cell}>{n.sign(kundli.ascendant.sign)}</td>
              <td className={`${cell} font-mono`}>{kundli.ascendant.dms_in_sign}</td>
              <td className={cell}>
                {n.nakshatra(kundli.ascendant.nakshatra)} ({kundli.ascendant.pada})
              </td>
              <td className="py-1">1</td>
            </tr>
          )}
          {kundli.grahas.map((g) => (
            <tr key={g.id} className="border-b border-border">
              <td className={cell}>
                {n.graha(g.id)}
                {g.retrograde && (
                  <abbr title={t("retro")} className="ml-1 no-underline">
                    {t("retroMark")}
                  </abbr>
                )}
              </td>
              <td className={cell}>{n.sign(g.sign)}</td>
              <td className={`${cell} font-mono`}>{g.dms_in_sign}</td>
              <td className={cell}>
                {n.nakshatra(g.nakshatra)} ({g.pada})
              </td>
              {known && <td className="py-1">{g.house}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-muted">{t("retroLegend")}</p>
    </div>
  );
}

function Gated({ result, children }: { result: ActionResult<unknown>; children: React.ReactNode }) {
  const te = useTranslations("toolsUi.errors");
  if (result.ok) return <>{children}</>;
  return (
    <p className="rounded-sm bg-bg px-3 py-2 text-sm text-muted">
      {te.has(result.code) ? te(result.code) : te("generic")}
    </p>
  );
}

export function KundliResult({
  kundli,
  dasha,
  doshas,
  birth,
}: {
  kundli: Kundli;
  dasha: ActionResult<Dasha>;
  doshas: ActionResult<Doshas>;
  birth: BirthInput;
}) {
  const t = useTranslations("toolsUi.result");
  const s = kundli.settings;
  return (
    <div className="space-y-6">
      <UnknownTimeNote kundli={kundli} />
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartToggle kundli={kundli} />
        <PlanetsTable kundli={kundli} />
      </div>
      <p className="text-xs text-muted">
        {t("settings", {
          ayanamsha: t.has(`ayanamshaName.${s.ayanamsha}`)
            ? t(`ayanamshaName.${s.ayanamsha}`)
            : s.ayanamsha,
          node: t.has(`nodeName.${s.node}`) ? t(`nodeName.${s.node}`) : s.node,
        })}
      </p>
      <section>
        <Gated result={dasha}>
          {dasha.ok && <DashaResult dasha={dasha.data} tz={kundli.birth.tz} />}
        </Gated>
      </section>
      <section>
        <h3 className="mb-3 font-semibold">{t("doshas")}</h3>
        <Gated result={doshas}>
          {doshas.ok && (
            <div className="grid gap-4 md:grid-cols-3">
              <MangalResult
                mangal={doshas.data.mangal}
                reviewStatus={doshas.data.tables_review_status}
              />
              <KaalSarpResult
                ks={doshas.data.kaal_sarp}
                reviewStatus={doshas.data.tables_review_status}
              />
              <SadeSatiResult
                ss={doshas.data.sade_sati}
                tz={kundli.birth.tz}
                reviewStatus={doshas.data.tables_review_status}
              />
            </div>
          )}
        </Gated>
      </section>
      <SaveKundli birth={birth} />
    </div>
  );
}
