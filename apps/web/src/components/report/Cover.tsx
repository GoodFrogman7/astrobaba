import { BRAND_NAME, DISCLAIMER } from "@astro/shared";
import type { ReportCtx } from "@/lib/report/context";
import { shortRef } from "@/lib/report/derive";
import type { RenderData, SnapshotEntry } from "@/lib/report/types";

export function birthTime(c: ReportCtx, e: SnapshotEntry): string {
  return e.birth.time ?? c.t("common.unknown");
}

export function Cover({ c, data }: { c: ReportCtx; data: RenderData }) {
  const { report, snapshot } = data;
  const people = snapshot.kundlis.slice(0, report.sku === "matching_report" ? 2 : 1);
  return (
    <section className="r-cover" data-section="cover">
      <p className="r-brand">{BRAND_NAME}</p>
      <h1 className="r-title">{c.t(`title.${report.sku}`)}</h1>
      <p className="r-subtitle">{c.t(`subtitle.${report.sku}`)}</p>

      <div className="r-cover-people">
        {people.map((e, i) => (
          <div key={`${e.label}-${i}`} className="r-cover-person" data-person={i + 1}>
            <p className="r-muted">
              {people.length > 1
                ? `${c.tf(i === 0 ? "partner1" : "partner2")}`
                : c.t("cover.preparedFor")}
            </p>
            <p className="r-cover-name">{e.label}</p>
            <p>
              {c.calendarDate(e.birth.date)} · {birthTime(c, e)}
            </p>
            <p>{e.birth.place.name}</p>
          </div>
        ))}
      </div>

      <div className="r-cover-foot">
        <p>{c.t("cover.preparedOn", { date: c.dateTime(report.created_at) })}</p>
        <p>{c.t("cover.reference", { ref: shortRef(report.id) })}</p>
        <p className="r-cover-note">{c.t("cover.calculated")}</p>
        <p className="r-cover-disclaimer" data-disclaimer="">
          {DISCLAIMER[c.lang]}
        </p>
      </div>
    </section>
  );
}

export function Contents({ c, titles }: { c: ReportCtx; titles: string[] }) {
  return (
    <section className="r-section" data-section="contents" aria-labelledby="contents-h">
      <h2 id="contents-h" className="r-h2">
        {c.t("contents.heading")}
      </h2>
      <ol className="r-toc">
        {titles.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ol>
      <h3 className="r-h3">{c.t("contents.about")}</h3>
      {c.paras("contents.aboutText").map((p) => (
        <p key={p.slice(0, 40)} className="r-p">
          {p}
        </p>
      ))}
    </section>
  );
}
