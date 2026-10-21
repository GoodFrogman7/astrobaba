import { BRAND_NAME } from "@astro/shared";
import type { ReactNode } from "react";
import { reportContext, type ReportCtx } from "@/lib/report/context";
import { dashaNow, shortRef } from "@/lib/report/derive";
import { cssString, fontStack } from "@/lib/report/fonts";
import type { RenderData, SnapshotEntry } from "@/lib/report/types";
import { BirthPairSection, BirthSection, PanchangSection, PeriodsSection } from "./BirthSections";
import { ChartPairSection, NorthChartSection, SouthChartSection } from "./ChartSections";
import { DisclaimerSection, MethodSection } from "./ClosingSections";
import { Contents, Cover } from "./Cover";
import { DashaSection } from "./DashaSection";
import { DoshasSection, SadeSatiSection } from "./DoshaSections";
import { AshtakootaSection, MangalCompatSection, MoonsSection } from "./MatchingSections";
import { NumerologySection } from "./NumerologySection";
import { HousesSection, NakshatrasSection, PlanetsSection } from "./PlacementSections";

interface Part {
  id: string;
  title: string;
  node: ReactNode;
}

function kundliParts(c: ReportCtx, data: RenderData, e: SnapshotEntry): Part[] {
  const meta = data.snapshot.meta;
  const asOf = dashaNow(e.dasha).asOf ?? data.report.created_at;
  const parts: (Part | null)[] = [
    { id: "birth", title: c.t("birth.heading"), node: <BirthSection c={c} e={e} /> },
    { id: "panchang", title: c.t("panchang.heading"), node: <PanchangSection c={c} e={e} /> },
    e.panchang.choghadiya || e.panchang.hora?.length
      ? { id: "periods", title: c.t("periods.heading"), node: <PeriodsSection c={c} e={e} /> }
      : null,
    {
      id: "chart-north",
      title: c.t("charts.northHeading"),
      node: <NorthChartSection c={c} e={e} />,
    },
    {
      id: "chart-south",
      title: c.t("charts.southHeading"),
      node: <SouthChartSection c={c} e={e} />,
    },
    { id: "planets", title: c.t("planets.heading"), node: <PlanetsSection c={c} e={e} /> },
    { id: "houses", title: c.t("houses.heading"), node: <HousesSection c={c} e={e} /> },
    {
      id: "nakshatras",
      title: c.t("nakshatras.heading"),
      node: (
        <NakshatrasSection
          c={c}
          e={e}
          reviewStatus={meta.tables_review_status.nakshatra_attributes}
        />
      ),
    },
    { id: "dasha", title: c.t("dasha.heading"), node: <DashaSection c={c} e={e} /> },
    { id: "doshas", title: c.t("doshas.heading"), node: <DoshasSection c={c} e={e} /> },
    {
      id: "sade-sati",
      title: c.t("doshas.sadeSatiHeading"),
      node: <SadeSatiSection c={c} e={e} asOf={asOf} />,
    },
    e.numerology
      ? {
          id: "numerology",
          title: c.t("numerology.heading"),
          node: <NumerologySection c={c} n={e.numerology} name={e.label} />,
        }
      : null,
  ];
  return parts.filter((p): p is Part => p !== null);
}

function matchingParts(c: ReportCtx, data: RenderData): Part[] {
  const [a, b] = data.snapshot.kundlis as [SnapshotEntry, SnapshotEntry];
  const match = data.snapshot.match!;
  const meta = data.snapshot.meta;
  const people: [SnapshotEntry, SnapshotEntry] = [a, b];
  const perPerson = people.flatMap((e, i) => {
    const charts = c.t("charts.headingFor", { name: e.label });
    const planets = c.t("planets.headingFor", { name: e.label });
    const panchang = `${c.t("panchang.heading")}: ${e.label}`;
    return [
      {
        id: `panchang-${i + 1}`,
        title: panchang,
        node: <PanchangSection c={c} e={e} id={`panchang-${i + 1}`} title={panchang} />,
      },
      {
        id: `charts-${i + 1}`,
        title: charts,
        node: <ChartPairSection c={c} e={e} id={`charts-${i + 1}`} title={charts} />,
      },
      {
        id: `planets-${i + 1}`,
        title: planets,
        node: <PlanetsSection c={c} e={e} id={`planets-${i + 1}`} title={planets} />,
      },
    ];
  });
  return [
    { id: "birth", title: c.t("birth.heading"), node: <BirthPairSection c={c} a={a} b={b} /> },
    ...perPerson,
    {
      id: "moons",
      title: c.t("matching.moonsHeading"),
      node: (
        <MoonsSection
          c={c}
          match={match}
          people={people}
          reviewStatus={meta.tables_review_status.nakshatra_attributes}
        />
      ),
    },
    {
      id: "ashtakoota",
      title: c.t("matching.ashtakootaHeading"),
      node: <AshtakootaSection c={c} match={match} />,
    },
    {
      id: "mangal-match",
      title: c.t("matching.mangalHeading"),
      node: (
        <MangalCompatSection
          c={c}
          match={match}
          people={people}
          reviewStatus={match.tables_review_status}
        />
      ),
    },
  ];
}

/**
 * The whole printable report: cover, contents, the sections of docs/api/revenue.md §2.4, method
 * and disclaimer. Pure server markup (no client JS); print rules live in report.css.
 */
export function ReportDocument({ data }: { data: RenderData }) {
  const lang = data.report.language;
  const c = reportContext(lang);
  const first = data.snapshot.kundlis[0]!;
  const body =
    data.report.sku === "matching_report" ? matchingParts(c, data) : kundliParts(c, data, first);
  const parts: Part[] = [
    ...body,
    {
      id: "method",
      title: c.t("method.heading"),
      node: <MethodSection c={c} data={data} e={first} />,
    },
    { id: "disclaimer", title: c.t("disclaimer.heading"), node: <DisclaimerSection c={c} /> },
  ];
  const font = fontStack(lang);
  // Brand and reference only: Chromium misplaces Devanagari pre-base vowel signs inside @page
  // margin boxes (stray marks above the footer), so the footer stays Latin; "पृष्ठ" is safe.
  const footerLeft = `${BRAND_NAME} · ${shortRef(data.report.id)}`;
  const pageCss = `@page{@bottom-left{content:${cssString(footerLeft)};font-family:${font};font-size:7.5pt;color:#565b70}@bottom-right{content:${cssString(`${c.t("pageFooter")} `)} counter(page) ${cssString(` ${c.t("pageOf")} `)} counter(pages);font-family:${font};font-size:7.5pt;color:#565b70}}@page :first{@bottom-left{content:none}@bottom-right{content:none}}`;

  return (
    <article
      className="report"
      lang={lang}
      data-report={data.report.sku}
      data-language={lang}
      style={{ fontFamily: font }}
    >
      {/* Page footer text (@page margin boxes). Every string goes through cssString, which
          strips < and >, so this cannot close the style element. */}
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <Cover c={c} data={data} />
      <Contents c={c} titles={parts.map((p) => p.title)} />
      {parts.map((p) => (
        <div key={p.id} className="r-part">
          {p.node}
        </div>
      ))}
    </article>
  );
}
