import type { ReportCtx } from "@/lib/report/context";
import { dashaNow, isAt } from "@/lib/report/derive";
import type { ReportDasha, SnapshotEntry } from "@/lib/report/types";
import { H3, HowTo, Section } from "./parts";

function AntarTable({
  c,
  dasha,
  index,
  which,
  asOf,
}: {
  c: ReportCtx;
  dasha: ReportDasha;
  index: number;
  which: "current" | "next";
  asOf: string | null;
}) {
  const m = dasha.mahadashas[index];
  if (!m) return null;
  return (
    <div className="r-block r-keep" data-antardashas={which}>
      <H3>
        {c.t("dasha.antarHeading", { lord: c.graha(m.lord) })} ({c.t(`dasha.${which}`)})
      </H3>
      <table className="r-table">
        <thead>
          <tr>
            <th scope="col">{c.t("dasha.antarLord")}</th>
            <th scope="col">{c.t("dasha.from")}</th>
            <th scope="col">{c.t("dasha.to")}</th>
            <th scope="col">{c.t("dasha.years")}</th>
          </tr>
        </thead>
        <tbody>
          {m.antardashas.map((a) => {
            const now = asOf !== null && isAt(a, asOf);
            return (
              <tr key={a.start} className={now ? "r-mark" : undefined}>
                <th scope="row">
                  {c.graha(a.lord)}
                  {now && <span className="r-tag">{c.t("dasha.now")}</span>}
                </th>
                <td className="r-num">{c.date(a.start)}</td>
                <td className="r-num">{c.date(a.end)}</td>
                <td className="r-num">{c.num(a.years, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function DashaSection({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  const d = e.dasha;
  const { asOf, current, next } = dashaNow(d);
  const birth = Date.parse(e.kundli.birth.utc);
  return (
    <Section id="dasha" title={c.t("dasha.heading")}>
      <HowTo c={c} paras={c.paras("dasha.howTo")} />
      <p className="r-p">
        {c.tr("balance", {
          lord: c.graha(d.balance_at_birth.lord),
          years: d.balance_at_birth.years.toFixed(2),
        })}
      </p>
      {asOf && (
        <p className="r-p r-strong" data-dasha-now="">
          {d.current
            ? c.t("dasha.running", {
                date: c.dateLong(asOf),
                maha: c.graha(d.current.mahadasha),
                antar: d.current.antardasha ? c.graha(d.current.antardasha) : c.t("common.none"),
              })
            : c.t("dasha.noCurrent", { date: c.dateLong(asOf) })}
        </p>
      )}
      <table className="r-table" data-mahadashas="">
        <caption>{c.tr("dashaTable")}</caption>
        <thead>
          <tr>
            <th scope="col">{c.t("dasha.lord")}</th>
            <th scope="col">{c.t("dasha.from")}</th>
            <th scope="col">{c.t("dasha.to")}</th>
            <th scope="col">{c.t("dasha.years")}</th>
          </tr>
        </thead>
        <tbody>
          {d.mahadashas.map((m, i) => (
            <tr key={m.start} className={i === current ? "r-mark" : undefined}>
              <th scope="row">
                {c.graha(m.lord)}
                {i === current && <span className="r-tag">{c.t("dasha.now")}</span>}
              </th>
              <td className="r-num">
                {c.date(m.start)}
                {i === 0 && Date.parse(m.start) < birth && (
                  <span className="r-muted"> ({c.tr("startedBeforeBirth")})</span>
                )}
              </td>
              <td className="r-num">{c.date(m.end)}</td>
              <td className="r-num">{c.num(m.years, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {current >= 0 && (
        <div className="r-break">
          <AntarTable c={c} dasha={d} index={current} which="current" asOf={asOf} />
          {next >= 0 && <AntarTable c={c} dasha={d} index={next} which="next" asOf={asOf} />}
        </div>
      )}
    </Section>
  );
}
