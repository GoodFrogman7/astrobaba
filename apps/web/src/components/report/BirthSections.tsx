import type { NamedSpan } from "@/lib/almanac/types";
import type { ReportCtx } from "@/lib/report/context";
import { isAt, spanAt } from "@/lib/report/derive";
import type { SnapshotEntry } from "@/lib/report/types";
import { Facts, H3, HowTo, ReviewNote, Section } from "./parts";

const known = (e: SnapshotEntry) => !e.kundli.birth.unknown_time;

export function BirthDetailsBlock({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  const b = e.kundli.birth;
  const tz = b.tz;
  return (
    <div className="r-keep" data-birth="">
      <Facts
        rows={[
          [c.t("birth.name"), e.label],
          [c.t("birth.date"), c.calendarDate(e.birth.date)],
          [c.t("birth.time"), known(e) ? `${c.clock(b.utc, tz)} (${tz})` : c.t("common.unknown")],
          [c.t("birth.place"), e.birth.place.name],
          [c.t("birth.coords"), c.coords(e.birth.place.lat, e.birth.place.lon)],
          [c.t("birth.tz"), tz],
          [c.t("birth.offset"), b.utc_offset],
          [c.t("birth.utc"), known(e) ? c.utc(b.utc) : c.t("common.none")],
          [
            c.t("birth.jd"),
            known(e) && b.julian_day_ut != null ? b.julian_day_ut.toFixed(5) : c.t("common.none"),
          ],
        ]}
      />
      {!known(e) && <p className="r-note">{c.t("birth.unknownTime")}</p>}
    </div>
  );
}

export function BirthSection({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  return (
    <Section id="birth" title={c.t("birth.heading")}>
      <HowTo c={c} paras={c.paras("birth.howTo")} />
      <BirthDetailsBlock c={c} e={e} />
    </Section>
  );
}

/** Birth details of both partners side by side (matching report). */
export function BirthPairSection({
  c,
  a,
  b,
}: {
  c: ReportCtx;
  a: SnapshotEntry;
  b: SnapshotEntry;
}) {
  return (
    <Section id="birth" title={c.t("birth.heading")}>
      <HowTo c={c} paras={c.paras("birth.howTo")} />
      {[a, b].map((e, i) => (
        <div key={i} className="r-block">
          <H3>{`${c.tf(i === 0 ? "partner1" : "partner2")}: ${e.label}`}</H3>
          <BirthDetailsBlock c={c} e={e} />
        </div>
      ))}
    </Section>
  );
}

function spanName(c: ReportCtx, s: NamedSpan): string {
  return c.lang === "hi" ? s.hi : s.en;
}

export function PanchangSection({
  c,
  e,
  id = "panchang",
  title,
}: {
  c: ReportCtx;
  e: SnapshotEntry;
  id?: string;
  title?: string;
}) {
  const p = e.panchang;
  const tz = p.place.tz;
  const birthUtc = e.kundli.birth.utc;
  const at = (iso: string) => c.clockOn(iso, tz, p.date);
  const elements: {
    key: string;
    label: string;
    spans: NamedSpan[];
    extra?: (s: NamedSpan) => string;
  }[] = [
    {
      key: "tithi",
      label: c.tp("tithi"),
      spans: p.tithis,
      extra: (s) =>
        "paksha" in s ? c.tp(`paksha.${(s as { paksha: "shukla" | "krishna" }).paksha}`) : "",
    },
    {
      key: "nakshatra",
      label: c.tp("nakshatra"),
      spans: p.nakshatras,
      extra: (s) =>
        "lord" in s ? `${c.tp("lord")}: ${c.graha((s as { lord: string }).lord)}` : "",
    },
    { key: "yoga", label: c.tp("yoga"), spans: p.yogas },
    { key: "karana", label: c.tp("karana"), spans: p.karanas },
  ];
  const beforeSunrise = known(e) && Date.parse(birthUtc) < Date.parse(p.sunrise);

  return (
    <Section id={id} title={title ?? c.t("panchang.heading")}>
      <HowTo c={c} paras={c.paras("panchang.howTo")} />
      {beforeSunrise && <p className="r-note">{c.t("panchang.beforeSunrise")}</p>}
      {!known(e) && <p className="r-note">{c.t("panchang.wholeDay")}</p>}
      <table className="r-table" data-panchang="">
        <thead>
          <tr>
            <th scope="col">{c.t("panchang.element")}</th>
            <th scope="col">{known(e) ? c.t("panchang.atBirth") : c.tp("name")}</th>
            <th scope="col">{c.t("panchang.began")}</th>
            <th scope="col">{c.t("panchang.ended")}</th>
          </tr>
        </thead>
        <tbody>
          {elements.flatMap((el) => {
            const spans = known(e)
              ? [spanAt(el.spans, birthUtc)].filter((s): s is NamedSpan => s !== null)
              : el.spans;
            if (spans.length === 0)
              return [
                <tr key={el.key}>
                  <th scope="row">{el.label}</th>
                  <td colSpan={3}>{c.t("common.none")}</td>
                </tr>,
              ];
            return spans.map((s, i) => (
              <tr key={`${el.key}-${s.start}`} data-element={el.key}>
                <th scope="row">{i === 0 ? el.label : ""}</th>
                <td>
                  <strong>{spanName(c, s)}</strong>
                  {el.extra?.(s) ? <span className="r-muted"> · {el.extra(s)}</span> : null}
                </td>
                <td className="r-num">{at(s.start)}</td>
                <td className="r-num">{at(s.end)}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>

      <H3>{`${c.t("panchang.dayHeading")}: ${c.calendarDate(p.date)}, ${e.birth.place.name}`}</H3>
      <Facts
        rows={[
          [c.tp("vaara"), c.lang === "hi" ? p.vaara.hi : p.vaara.en],
          [c.tp("sunrise"), at(p.sunrise)],
          [c.tp("sunset"), at(p.sunset)],
          [c.tp("rahuKaal"), `${at(p.rahu_kaal.start)} – ${at(p.rahu_kaal.end)}`],
        ]}
      />
      <p className="r-small r-muted">{c.t("panchang.timesIn", { tz })}</p>
    </Section>
  );
}

export function PeriodsSection({ c, e }: { c: ReportCtx; e: SnapshotEntry }) {
  const p = e.panchang;
  const tz = p.place.tz;
  const birthUtc = e.kundli.birth.utc;
  const at = (iso: string) => c.clockOn(iso, tz, p.date);
  const mark = (s: { start: string; end: string }) => known(e) && isAt(s, birthUtc);
  const chog = p.choghadiya;
  const hora = p.hora ?? [];
  if (!chog && hora.length === 0) return null;

  return (
    <Section id="periods" title={c.t("periods.heading")}>
      <HowTo c={c} paras={c.paras("periods.howTo")} />
      {chog && (
        <>
          <H3>{c.tp("choghadiya")}</H3>
          <div className="r-cols">
            {(["day", "night"] as const).map((part) => (
              <table key={part} className="r-table r-compact" data-choghadiya={part}>
                <caption>{c.tp(part === "day" ? "dayChoghadiya" : "nightChoghadiya")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{c.tp("period")}</th>
                    <th scope="col">{c.tp("name")}</th>
                    <th scope="col">{c.t("periods.nature")}</th>
                  </tr>
                </thead>
                <tbody>
                  {chog[part].map((s) => (
                    <tr key={s.start} className={mark(s) ? "r-mark" : undefined}>
                      <td className="r-num">
                        {at(s.start)}–{at(s.end)}
                      </td>
                      <td>
                        {c.lang === "hi" ? s.hi : s.en}
                        {mark(s) && <span className="r-tag">{c.t("periods.birthMark")}</span>}
                      </td>
                      <td>{c.tp(`nature.${s.nature}`)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
          <ReviewNote c={c} status={p.settings.tables_review_status?.choghadiya} />
        </>
      )}
      {hora.length > 0 && (
        <>
          <H3>{c.tp("hora")}</H3>
          <div className="r-cols">
            {(["day", "night"] as const).map((part) => (
              <table key={part} className="r-table r-compact" data-hora={part}>
                <caption>{c.tp(`part.${part}`)}</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{c.tp("period")}</th>
                    <th scope="col">{c.tp("lord")}</th>
                  </tr>
                </thead>
                <tbody>
                  {hora
                    .filter((h) => h.part === part)
                    .map((h) => (
                      <tr key={h.number} className={mark(h) ? "r-mark" : undefined}>
                        <td className="r-num">{h.number}</td>
                        <td className="r-num">
                          {at(h.start)}–{at(h.end)}
                        </td>
                        <td>
                          {c.graha(h.lord)}
                          {mark(h) && <span className="r-tag">{c.t("periods.birthMark")}</span>}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ))}
          </div>
        </>
      )}
      <p className="r-small r-muted">{c.t("panchang.timesIn", { tz })}</p>
    </Section>
  );
}
