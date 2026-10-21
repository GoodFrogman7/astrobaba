import type { ReportCtx } from "@/lib/report/context";
import type { SnapshotEntry } from "@/lib/report/types";
import type { Koota, Match } from "@/lib/tools/types";
import { MangalBlock } from "./DoshaSections";
import { HowTo, ReviewNote, Section } from "./parts";

const P = (c: ReportCtx, i: 0 | 1) => c.tf(i === 0 ? "partner1" : "partner2");

export function MoonsSection({
  c,
  match,
  people,
  reviewStatus,
}: {
  c: ReportCtx;
  match: Match;
  people: [SnapshotEntry, SnapshotEntry];
  reviewStatus: string | undefined;
}) {
  const moons = [match.groom.moon, match.bride.moon] as const;
  const rows = moons.map((m) => c.nakshatraRow(m.nakshatra));
  const line = (label: string, f: (i: 0 | 1) => string) => (
    <tr key={label}>
      <th scope="row">{label}</th>
      <td>{f(0)}</td>
      <td>{f(1)}</td>
    </tr>
  );
  return (
    <Section id="moons" title={c.t("matching.moonsHeading")}>
      <HowTo c={c} paras={c.paras("matching.moonsHowTo")} />
      <table className="r-table" data-moons="">
        <thead>
          <tr>
            <th scope="col">{c.t("matching.partner")}</th>
            <th scope="col">{`${P(c, 0)}: ${people[0].label}`}</th>
            <th scope="col">{`${P(c, 1)}: ${people[1].label}`}</th>
          </tr>
        </thead>
        <tbody>
          {line(c.t("matching.role"), (i) => c.t(i === 0 ? "matching.groom" : "matching.bride"))}
          {line(c.t("planets.sign"), (i) => c.sign(moons[i].sign))}
          {line(c.t("planets.degree"), (i) => moons[i].dms_in_sign)}
          {line(c.t("planets.signLord"), (i) => c.graha(moons[i].sign_lord))}
          {line(c.t("planets.nakshatra"), (i) => c.nakshatra(moons[i].nakshatra))}
          {line(c.t("planets.pada"), (i) => String(moons[i].pada))}
          {line(c.t("planets.nakLord"), (i) => c.graha(moons[i].nakshatra_lord))}
          {line(c.t("nakshatras.gana"), (i) => c.attr("gana", rows[i]?.gana))}
          {line(c.t("nakshatras.nadi"), (i) => c.attr("nadi", rows[i]?.nadi))}
          {line(c.t("nakshatras.yoni"), (i) => c.attr("yoni", rows[i]?.yoni.animal))}
        </tbody>
      </table>
      <p className="r-small r-muted">{c.tm("convention")}</p>
      <ReviewNote c={c} status={reviewStatus} />
    </Section>
  );
}

const PAIR_GROUP: Record<string, string> = {
  varna: "varna",
  vashya: "vashya",
  yoni: "yoni",
  gana: "gana",
  nadi: "nadi",
};

function detail(c: ReportCtx, k: Koota): string {
  const d = k.detail as Record<string, string | number | undefined>;
  const group = PAIR_GROUP[k.koota];
  if (group)
    return `${P(c, 0)}: ${c.attr(group, String(d.groom))} · ${P(c, 1)}: ${c.attr(group, String(d.bride))}`;
  if (k.koota === "tara")
    return c.t("matching.taraDetail", {
      a: String(d.bride_to_groom),
      b: String(d.groom_to_bride),
    });
  if (k.koota === "graha_maitri") {
    const rel = String(d.relation ?? "");
    const parts =
      rel === "same_lord"
        ? [c.attr("relation", "same")]
        : rel.split("_").map((r) => c.attr("relation", r));
    return c.t("matching.maitriDetail", {
      a: c.graha(String(d.groom_lord)),
      b: c.graha(String(d.bride_lord)),
      relation: parts.join(" / "),
    });
  }
  if (k.koota === "bhakoot") return c.t("matching.bhakootDetail", { n: String(d.sign_distance) });
  return "";
}

const KOOTAS = [
  "varna",
  "vashya",
  "tara",
  "yoni",
  "graha_maitri",
  "gana",
  "bhakoot",
  "nadi",
] as const;
type KootaId = (typeof KOOTAS)[number];
const kootaKey = (k: string): KootaId | null =>
  (KOOTAS as readonly string[]).includes(k) ? (k as KootaId) : null;

export function AshtakootaSection({ c, match }: { c: ReportCtx; match: Match }) {
  return (
    <Section id="ashtakoota" title={c.t("matching.ashtakootaHeading")}>
      <HowTo c={c} paras={c.paras("matching.ashtakootaHowTo")} />
      <table className="r-table" data-ashtakoota="">
        <thead>
          <tr>
            <th scope="col">{c.tm("koota")}</th>
            <th scope="col">{c.tm("measures")}</th>
            <th scope="col">{c.t("matching.compared")}</th>
            <th scope="col" className="r-right">
              {c.tm("points")}
            </th>
            <th scope="col" className="r-right">
              {c.t("matching.max")}
            </th>
          </tr>
        </thead>
        <tbody>
          {match.kootas.map((k) => {
            const key = kootaKey(k.koota);
            return (
              <tr key={k.koota} data-koota={k.koota}>
                <th scope="row">{key ? c.tm(`kootaName.${key}`) : k.koota}</th>
                <td>{key ? c.tm(`kootaInfo.${key}`) : ""}</td>
                <td className="r-small">{detail(c, k)}</td>
                <td className="r-num r-right">{c.num(k.points, 1)}</td>
                <td className="r-num r-right">{k.max}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr data-total="">
            <th scope="row" colSpan={3}>
              {c.t("matching.total")}
            </th>
            <td className="r-num r-right">{c.num(match.total, 1)}</td>
            <td className="r-num r-right">{match.max}</td>
          </tr>
        </tfoot>
      </table>
      <p className="r-p r-strong">
        {c.tm("total", { total: c.num(match.total, 1), max: match.max })}
      </p>
      <h3 className="r-h3">{c.t("matching.doshaHeading")}</h3>
      <ul className="r-list" data-match-doshas="">
        {match.doshas.nadi && <li>{c.tm("nadiDosha")}</li>}
        {match.doshas.bhakoot && <li>{c.tm("bhakootDosha")}</li>}
        {!match.doshas.nadi && !match.doshas.bhakoot && <li>{c.tm("noDosha")}</li>}
      </ul>
      <p className="r-small r-muted">{c.tm("convention")}</p>
      <ReviewNote c={c} status={match.tables_review_status} />
    </Section>
  );
}

export function MangalCompatSection({
  c,
  match,
  people,
  reviewStatus,
}: {
  c: ReportCtx;
  match: Match;
  people: [SnapshotEntry, SnapshotEntry];
  reviewStatus: string | undefined;
}) {
  const sides = [match.groom.mangal_dosha, match.bride.mangal_dosha] as const;
  const [a, b] = [sides[0].present, sides[1].present];
  const summary =
    a && b
      ? c.t("matching.mangalBoth")
      : !a && !b
        ? c.t("matching.mangalNeither")
        : c.t("matching.mangalOne", { name: a ? people[0].label : people[1].label });
  return (
    <Section id="mangal-match" title={c.t("matching.mangalHeading")}>
      <HowTo c={c} paras={c.paras("matching.mangalHowTo")} />
      <p className="r-p r-strong" data-mangal-summary="">
        {summary}
      </p>
      {sides.map((m, i) => (
        <MangalBlock
          key={i}
          c={c}
          mangal={m}
          reviewStatus={reviewStatus}
          title={`${P(c, i as 0 | 1)}: ${people[i]!.label}`}
        />
      ))}
    </Section>
  );
}
