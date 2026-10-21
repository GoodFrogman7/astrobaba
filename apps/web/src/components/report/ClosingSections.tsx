import { DISCLAIMER } from "@astro/shared";
import type { ReportCtx } from "@/lib/report/context";
import type { RenderData, SnapshotEntry } from "@/lib/report/types";
import { Facts, HowTo, Section } from "./parts";

const TABLE_KEYS = [
  "matching",
  "doshas",
  "nakshatra_attributes",
  "numerology",
  "choghadiya",
] as const;
type TableKey = (typeof TABLE_KEYS)[number];

const EPHEMERIS_NAMES: Record<string, string> = { swiss_ephemeris: "Swiss Ephemeris" };

export function MethodSection({
  c,
  data,
  e,
}: {
  c: ReportCtx;
  data: RenderData;
  e: SnapshotEntry;
}) {
  const s = e.kundli.settings;
  const meta = data.snapshot.meta;
  const statuses: Record<string, string> = { ...meta.tables_review_status };
  if (e.numerology) statuses.numerology = e.numerology.review_status;
  const chog = e.panchang.settings.tables_review_status?.choghadiya;
  if (chog) statuses.choghadiya = chog;
  const engine =
    meta.version && meta.version !== data.report.engine_version
      ? `${data.report.engine_version} (${meta.version})`
      : data.report.engine_version;

  return (
    <Section id="method" title={c.t("method.heading")}>
      <HowTo c={c} paras={c.paras("method.howTo")} />
      <Facts
        rows={[
          [
            c.t("method.zodiac"),
            s.zodiac === "sidereal" || !s.zodiac ? c.t("method.sidereal") : s.zodiac,
          ],
          [
            c.t("method.ayanamsha"),
            c.t("method.ayanamshaValue", {
              name: c.tr.has(`ayanamshaName.${s.ayanamsha}` as "ayanamshaName.lahiri")
                ? c.tr(`ayanamshaName.${s.ayanamsha}` as "ayanamshaName.lahiri")
                : s.ayanamsha,
              deg: c.deg(s.ayanamsha_deg, 4),
            }),
          ],
          [
            c.t("method.node"),
            c.tr.has(`nodeName.${s.node}` as "nodeName.mean")
              ? c.tr(`nodeName.${s.node}` as "nodeName.mean")
              : s.node,
          ],
          [
            c.t("method.houses"),
            s.house_system === "whole_sign" ? c.t("method.wholeSign") : s.house_system,
          ],
          [c.t("method.positions"), s.positions ?? c.t("common.none")],
          [
            c.t("method.ephemeris"),
            `${EPHEMERIS_NAMES[meta.ephemeris_backend] ?? meta.ephemeris_backend} ${meta.ephemeris_version}`,
          ],
          [c.t("method.engine"), engine],
          [c.t("method.sunrise"), e.panchang.settings.sunrise_convention ?? c.t("common.none")],
          [
            c.t("method.dashaYear"),
            e.dasha.year_days
              ? c.t("method.days", { n: String(e.dasha.year_days) })
              : c.t("common.none"),
          ],
          [
            c.t("method.tables"),
            <ul key="t" className="r-list r-list-tight" data-table-status="">
              {Object.entries(statuses).map(([k, v]) => (
                <li key={k} data-table={k} data-status={v}>
                  {(TABLE_KEYS as readonly string[]).includes(k)
                    ? c.t(`method.table.${k as TableKey}`)
                    : k}
                  : {v === "verified" ? c.t("common.verified") : c.t("common.pending")}
                </li>
              ))}
            </ul>,
          ],
          [c.t("method.time"), c.t("method.timeValue")],
          [c.t("method.names"), c.t("method.namesValue")],
          [c.t("method.places"), c.t("method.placesValue")],
          [c.t("method.source"), `${meta.source} (${meta.license})`],
        ]}
      />
    </Section>
  );
}

export function DisclaimerSection({ c }: { c: ReportCtx }) {
  return (
    <Section id="disclaimer" title={c.t("disclaimer.heading")}>
      <p className="r-lead" data-disclaimer="">
        {DISCLAIMER[c.lang]}
      </p>
      {c.paras("disclaimer.body").map((p) => (
        <p key={p.slice(0, 40)} className="r-p">
          {p}
        </p>
      ))}
    </Section>
  );
}
