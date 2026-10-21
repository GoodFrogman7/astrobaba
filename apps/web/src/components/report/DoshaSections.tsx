import { Fragment } from "react";
import type { ReportCtx } from "@/lib/report/context";
import type { SnapshotEntry } from "@/lib/report/types";
import type { Doshas } from "@/lib/tools/types";
import { Facts, H3, HowTo, ReviewNote, Rule, Section } from "./parts";

const presence = (c: ReportCtx, present: boolean) =>
  present ? c.tr("present") : c.tr("notPresent");

export function MangalBlock({
  c,
  mangal,
  reviewStatus,
  title,
}: {
  c: ReportCtx;
  mangal: Doshas["mangal"];
  reviewStatus: string | undefined;
  title?: string;
}) {
  const h = mangal.mars_house_from;
  const house = (n: number | null) =>
    n == null ? c.t("common.none") : c.t("common.house", { house: n });
  const from = mangal.from
    .map((f) => (f === "lagna" ? c.t("doshas.lagna") : f === "moon" ? c.t("doshas.moonRef") : f))
    .join(", ");
  return (
    <div className="r-block r-keep" data-dosha="mangal" data-present={mangal.present}>
      <H3>{title ?? c.tr("mangal")}</H3>
      <p className="r-p">{c.t("doshas.mangalHowTo")}</p>
      <Facts
        rows={[
          [c.t("doshas.result"), <strong key="r">{presence(c, mangal.present)}</strong>],
          [c.t("doshas.fromLagna"), house(h.lagna)],
          [c.t("doshas.fromMoon"), house(h.moon)],
          [c.t("doshas.housesChecked"), mangal.houses_checked.join(", ")],
          [c.t("doshas.foundFrom"), from || c.t("common.none")],
        ]}
      />
      <Rule c={c} text={mangal.rule} />
      <ReviewNote c={c} status={reviewStatus} />
    </div>
  );
}

export function DoshasSection({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  const d = e.doshas;
  const ks = d.kaal_sarp;
  return (
    <Section id="doshas" title={c.t("doshas.heading")}>
      <HowTo c={c} paras={c.paras("doshas.howTo")} />
      <MangalBlock c={c} mangal={d.mangal} reviewStatus={d.tables_review_status} />
      <div className="r-block r-keep" data-dosha="kaal_sarp" data-present={ks.present}>
        <H3>{c.tr("kaalSarp")}</H3>
        <p className="r-p">{c.t("doshas.kaalSarpHowTo")}</p>
        <Facts
          rows={[
            [c.t("doshas.result"), <strong key="r">{presence(c, ks.present)}</strong>],
            [
              c.t("doshas.direction"),
              ks.direction === "rahu_to_ketu" || ks.direction === "ketu_to_rahu"
                ? c.tr(`kaalSarpDirection.${ks.direction}`)
                : c.t("common.none"),
            ],
            [c.t("doshas.type"), ks.type ?? c.t("common.none")],
          ]}
        />
        <Rule c={c} text={ks.rule} />
        <ReviewNote c={c} status={d.tables_review_status} />
      </div>
    </Section>
  );
}

export function SadeSatiSection({ c, e, asOf }: { c: ReportCtx; e: SnapshotEntry; asOf: string }) {
  const d = e.doshas;
  const ss = d.sade_sati;
  const moon = e.kundli.grahas.find((g) => g.id === "moon");
  const phase = (p: string) =>
    p === "rising" || p === "peak" || p === "setting" ? c.tr(`phase.${p}`) : p;
  return (
    <Section id="sade-sati" title={c.t("doshas.sadeSatiHeading")}>
      <HowTo c={c} paras={[c.t("doshas.sadeSatiHowTo", { years: ss.window_years ?? 100 })]} />
      <Facts
        rows={[
          [c.t("doshas.moonSign"), moon ? c.sign(moon.sign) : c.t("common.none")],
          [
            c.t("doshas.onDate", { date: c.dateLong(asOf) }),
            <strong key="s" data-sade-sati-active={ss.active}>
              {presence(c, ss.active)}
              {ss.current_phase
                ? ` · ${phase(ss.current_phase.phase)} (${c.date(ss.current_phase.start)} – ${c.date(ss.current_phase.end)})`
                : ""}
            </strong>,
          ],
        ]}
      />
      <Rule c={c} text={ss.rule} />
      <ReviewNote c={c} status={d.tables_review_status} />
      <table className="r-table r-compact" data-sade-sati="">
        <thead>
          <tr>
            <th scope="col">{c.t("doshas.phase")}</th>
            <th scope="col">{c.t("doshas.saturnIn")}</th>
            <th scope="col">{c.t("dasha.from")}</th>
            <th scope="col">{c.t("dasha.to")}</th>
          </tr>
        </thead>
        <tbody>
          {ss.cycles.map((cy, i) => (
            <Fragment key={cy.start}>
              <tr className="r-group">
                <th scope="rowgroup" colSpan={4}>
                  {c.t("doshas.cycle", { n: i + 1, start: c.date(cy.start), end: c.date(cy.end) })}
                </th>
              </tr>
              {cy.phases.map((p) => (
                <tr key={p.start}>
                  <td>{phase(p.phase)}</td>
                  <td>{c.signAt(p.saturn_sign_index)}</td>
                  <td className="r-num">{c.date(p.start)}</td>
                  <td className="r-num">{c.date(p.end)}</td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
