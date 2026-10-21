import type { ReportCtx } from "@/lib/report/context";
import { houseRows } from "@/lib/report/derive";
import type { SnapshotEntry } from "@/lib/report/types";
import type { Placement } from "@/lib/tools/types";
import { H3, HowTo, ReviewNote, Section } from "./parts";

export function PlanetsSection({
  c,
  e,
  id = "planets",
  title,
}: {
  c: ReportCtx;
  e: SnapshotEntry;
  id?: string;
  title?: string;
}) {
  const k = e.kundli;
  const known = k.ascendant !== null;
  const row = (p: Placement) => (
    <>
      <td>{c.sign(p.sign)}</td>
      <td className="r-num">{p.dms_in_sign}</td>
      <td className="r-num">{c.deg(p.longitude)}</td>
      <td>{c.nakshatra(p.nakshatra)}</td>
      <td className="r-num">{p.pada}</td>
      <td>{c.graha(p.sign_lord)}</td>
      <td>{c.graha(p.nakshatra_lord)}</td>
    </>
  );
  return (
    <Section id={id} title={title ?? c.t("planets.heading")}>
      <HowTo c={c} paras={c.paras("planets.howTo")} />
      <table className="r-table" data-planets="">
        <thead>
          <tr>
            <th scope="col">{c.t("planets.graha")}</th>
            <th scope="col">{c.t("planets.sign")}</th>
            <th scope="col">{c.t("planets.degree")}</th>
            <th scope="col">{c.t("planets.longitude")}</th>
            <th scope="col">{c.t("planets.nakshatra")}</th>
            <th scope="col">{c.t("planets.pada")}</th>
            <th scope="col">{c.t("planets.signLord")}</th>
            <th scope="col">{c.t("planets.nakLord")}</th>
            {known && <th scope="col">{c.t("planets.house")}</th>}
            <th scope="col">{c.t("planets.retro")}</th>
          </tr>
        </thead>
        <tbody>
          {k.ascendant && (
            <tr data-graha="ascendant" className="r-strong">
              <th scope="row">{c.t("planets.ascendant")}</th>
              {row(k.ascendant)}
              <td className="r-num">1</td>
              <td>{c.t("common.none")}</td>
            </tr>
          )}
          {k.grahas.map((g) => (
            <tr key={g.id} data-graha={g.id}>
              <th scope="row">{c.graha(g.id)}</th>
              {row(g)}
              {known && <td className="r-num">{g.house ?? c.t("common.none")}</td>}
              <td>
                {g.id === "rahu" || g.id === "ketu"
                  ? c.t("common.always")
                  : g.retrograde
                    ? c.t("common.yes")
                    : c.t("common.no")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!known && <p className="r-note">{c.t("birth.unknownTime")}</p>}
    </Section>
  );
}

export function HousesSection({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  const rows = houseRows(e.kundli, c.signLordAt);
  return (
    <Section id="houses" title={c.t("houses.heading")}>
      <HowTo c={c} paras={c.paras("houses.howTo")} />
      {rows ? (
        <table className="r-table" data-houses="">
          <thead>
            <tr>
              <th scope="col">{c.t("houses.house")}</th>
              <th scope="col">{c.t("houses.sign")}</th>
              <th scope="col">{c.t("houses.lord")}</th>
              <th scope="col">{c.t("houses.lordIn")}</th>
              <th scope="col">{c.t("houses.occupants")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h) => (
              <tr key={h.house} data-house={h.house}>
                <th scope="row" className="r-num">
                  {h.house}
                </th>
                <td>{c.signAt(h.signIndex)}</td>
                <td>{c.graha(h.lord)}</td>
                <td>
                  {h.lordHouse != null
                    ? c.t("common.house", { house: h.lordHouse })
                    : c.t("common.none")}
                </td>
                <td>
                  {h.occupants.length
                    ? h.occupants.map((g) => c.graha(g)).join(", ")
                    : c.t("common.none")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="r-note">{c.t("houses.noTime")}</p>
      )}
    </Section>
  );
}

export function NakshatrasSection({
  c,
  e,
  reviewStatus,
}: {
  c: ReportCtx;
  e: SnapshotEntry;
  reviewStatus: string | undefined;
}) {
  const k = e.kundli;
  const g = (id: string) => k.grahas.find((x) => x.id === id);
  const cols: { key: string; title: string; p: Placement | null | undefined }[] = [
    { key: "moon", title: c.t("nakshatras.moon"), p: g("moon") },
    { key: "sun", title: c.t("nakshatras.sun"), p: g("sun") },
    { key: "ascendant", title: c.t("nakshatras.ascendant"), p: k.ascendant },
  ];
  const none = c.t("common.none");
  const line = (label: string, f: (p: Placement) => string) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      {cols.map((col) => (
        <td key={col.key}>{col.p ? f(col.p) : none}</td>
      ))}
    </tr>
  );
  const row = (p: Placement) => c.nakshatraRow(p.nakshatra);
  return (
    <Section id="nakshatras" title={c.t("nakshatras.heading")}>
      <HowTo c={c} paras={c.paras("nakshatras.howTo")} />
      <table className="r-table" data-nakshatras="">
        <thead>
          <tr>
            <th scope="col" />
            {cols.map((col) => (
              <th key={col.key} scope="col" data-nakshatra={col.p?.nakshatra ?? "none"}>
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {line(c.t("nakshatras.name"), (p) => c.nakshatra(p.nakshatra))}
          {line(c.t("nakshatras.number"), (p) =>
            c.t("nakshatras.numberValue", { n: p.nakshatra_index + 1 }),
          )}
          {line(c.t("nakshatras.lord"), (p) => c.graha(p.nakshatra_lord))}
          {line(c.t("nakshatras.pada"), (p) => String(p.pada))}
          {line(c.t("nakshatras.sign"), (p) => `${c.sign(p.sign)} ${p.dms_in_sign}`)}
        </tbody>
      </table>
      {!k.ascendant && <p className="r-note">{c.t("nakshatras.noAscendant")}</p>}
      <H3>{c.t("nakshatras.attributes")}</H3>
      <table className="r-table" data-nakshatra-attributes="">
        <thead>
          <tr>
            <th scope="col" />
            {cols.map((col) => (
              <th key={col.key} scope="col">
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {line(c.t("nakshatras.gana"), (p) => c.attr("gana", row(p)?.gana))}
          {line(c.t("nakshatras.nadi"), (p) => c.attr("nadi", row(p)?.nadi))}
          {line(c.t("nakshatras.yoni"), (p) => {
            const r = row(p);
            return r
              ? `${c.attr("yoni", r.yoni.animal)} (${c.t(r.yoni.gender === "f" ? "common.female" : "common.male")})`
              : none;
          })}
        </tbody>
      </table>
      <ReviewNote c={c} status={reviewStatus} />
    </Section>
  );
}
