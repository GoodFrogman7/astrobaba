import {
  CHART_LABELS,
  NorthIndianChart,
  SouthIndianChart,
  type GrahaId,
} from "@/components/charts";
import type { ReportCtx } from "@/lib/report/context";
import type { SnapshotEntry } from "@/lib/report/types";
import { HowTo, Section } from "./parts";

const GRAHAS: GrahaId[] = [
  "sun",
  "moon",
  "mars",
  "mercury",
  "jupiter",
  "venus",
  "saturn",
  "rahu",
  "ketu",
];

function Legend({ c }: { c: ReportCtx }) {
  const l = CHART_LABELS[c.lang];
  return (
    <p className="r-legend">
      <span className="r-muted">{c.t("charts.legend")}:</span>{" "}
      {GRAHAS.map((g) => `${l.grahaShort[g]} = ${l.grahaName[g]}`).join(" · ")} · {l.asc} ={" "}
      {l.ascendant} · {l.retro} = {c.t("planets.retro")}
    </p>
  );
}

export function NorthChartSection({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  return (
    <Section id="chart-north" title={c.t("charts.northHeading")}>
      <HowTo c={c} paras={c.paras("charts.northHowTo")} />
      <div className="r-chart">
        <NorthIndianChart data={e.kundli} locale={c.lang} />
      </div>
      <Legend c={c} />
    </Section>
  );
}

export function SouthChartSection({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  return (
    <Section id="chart-south" title={c.t("charts.southHeading")}>
      <HowTo c={c} paras={c.paras("charts.southHowTo")} />
      <div className="r-chart">
        <SouthIndianChart data={e.kundli} locale={c.lang} />
      </div>
      <Legend c={c} />
    </Section>
  );
}

/** Both chart styles for one partner on one page (matching report). */
export function ChartPairSection({
  c,
  e,
  id,
  title,
}: {
  c: ReportCtx;
  e: SnapshotEntry;
  id: string;
  title: string;
}) {
  return (
    <Section id={id} title={title}>
      <HowTo c={c} paras={c.paras("charts.bothHowTo")} />
      <div className="r-chart-pair">
        <div>
          <p className="r-chart-cap">{c.t("charts.northHeading")}</p>
          <NorthIndianChart data={e.kundli} locale={c.lang} />
        </div>
        <div>
          <p className="r-chart-cap">{c.t("charts.southHeading")}</p>
          <SouthIndianChart data={e.kundli} locale={c.lang} />
        </div>
      </div>
      <Legend c={c} />
    </Section>
  );
}
