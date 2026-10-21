"use client";

import { useTranslations } from "next-intl";
import type { Dasha, Doshas, Kundli, Numerology, Placement } from "@/lib/tools/types";
import { useAstroNames } from "./names";

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-border bg-surface p-4">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-2 space-y-2 leading-relaxed">{children}</div>
    </section>
  );
}

export function PendingReview({ status }: { status: string }) {
  const t = useTranslations("toolsUi.result");
  if (status === "verified") return null;
  return <p className="rounded-sm bg-bg px-3 py-2 text-sm text-muted">{t("pendingReview")}</p>;
}

export function UnknownTimeNote({ kundli }: { kundli: Kundli }) {
  const t = useTranslations("toolsUi.result");
  const n = useAstroNames();
  if (!kundli.flags.includes("unknown_birth_time")) return null;
  const r = kundli.moon_range;
  return (
    <div className="rounded-sm bg-bg px-3 py-2 text-sm text-muted">
      <p>{t("unknownTimeNote")}</p>
      {r && (
        <p className="mt-1">
          {t("moonRange", {
            start: `${n.sign(r.start.sign)}, ${n.nakshatra(r.start.nakshatra)}`,
            end: `${n.sign(r.end.sign)}, ${n.nakshatra(r.end.nakshatra)}`,
          })}
        </p>
      )}
    </div>
  );
}

function PlacementLine({ p }: { p: Placement }) {
  const t = useTranslations("toolsUi.result");
  const n = useAstroNames();
  return (
    <p>
      <strong>{n.sign(p.sign)}</strong> {p.dms_in_sign} · {n.nakshatra(p.nakshatra)} (
      {t("pada", { pada: p.pada })}) · {t("lord", { lord: n.graha(p.sign_lord) })}
    </p>
  );
}

export function SunMoonAscendant({ kundli }: { kundli: Kundli }) {
  const t = useTranslations("toolsUi.result");
  const g = Object.fromEntries(kundli.grahas.map((x) => [x.id, x]));
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card title={t("sun")}>{g.sun && <PlacementLine p={g.sun} />}</Card>
      <Card title={t("moon")}>{g.moon && <PlacementLine p={g.moon} />}</Card>
      <Card title={t("ascendant")}>
        {kundli.ascendant ? <PlacementLine p={kundli.ascendant} /> : <p>{t("unknownAscendant")}</p>}
      </Card>
    </div>
  );
}

export function NakshatraResult({ kundli }: { kundli: Kundli }) {
  const t = useTranslations("toolsUi.result");
  const n = useAstroNames();
  const moon = kundli.grahas.find((x) => x.id === "moon");
  if (!moon) return null;
  return (
    <Card title={t("nakshatra")}>
      <p className="text-2xl font-semibold">{n.nakshatra(moon.nakshatra)}</p>
      <p>
        {t("pada", { pada: moon.pada })} · {t("lord", { lord: n.graha(moon.nakshatra_lord) })}
      </p>
      <p>
        {t("moon")}: {n.sign(moon.sign)} {moon.dms_in_sign}
      </p>
    </Card>
  );
}

export function DashaResult({ dasha, tz }: { dasha: Dasha; tz: string }) {
  const t = useTranslations("toolsUi.result");
  const n = useAstroNames();
  const birth = Date.parse(dasha.mahadashas[0]?.start ?? "");
  return (
    <div className="space-y-4">
      {dasha.current && (
        <Card title={t("currentDasha")}>
          <p>
            {t("mahadasha")}: <strong>{n.graha(dasha.current.mahadasha)}</strong>
            {dasha.current.antardasha && (
              <>
                {" "}
                · {t("antardasha")}: <strong>{n.graha(dasha.current.antardasha)}</strong>
              </>
            )}
          </p>
        </Card>
      )}
      <p className="text-sm text-muted">
        {t("balance", {
          lord: n.graha(dasha.balance_at_birth.lord),
          years: dasha.balance_at_birth.years.toFixed(2),
        })}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="mb-2 text-left font-semibold">{t("dashaTable")}</caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1 pr-3">
                {t("mahadasha")}
              </th>
              <th scope="col" className="py-1 pr-3">
                {t("from")}
              </th>
              <th scope="col" className="py-1">
                {t("to")}
              </th>
            </tr>
          </thead>
          <tbody>
            {dasha.mahadashas.map((m, i) => (
              <tr key={m.start} className="border-b border-border">
                <td className="py-1 pr-3">{n.graha(m.lord)}</td>
                <td className="py-1 pr-3">
                  {n.date(m.start, tz)}
                  {i === 0 && Number.isFinite(birth) && (
                    <span className="text-muted"> ({t("startedBeforeBirth")})</span>
                  )}
                </td>
                <td className="py-1">{n.date(m.end, tz)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MangalResult({
  mangal,
  reviewStatus,
}: {
  mangal: Doshas["mangal"];
  reviewStatus: string;
}) {
  const t = useTranslations("toolsUi.result");
  const h = mangal.mars_house_from;
  return (
    <Card title={t("mangal")}>
      <p className="text-xl font-semibold">{mangal.present ? t("present") : t("notPresent")}</p>
      <p>
        {h.lagna !== null
          ? t("marsHouseFrom", { lagna: h.lagna, moon: h.moon ?? "" })
          : t("marsHouseFromMoon", { moon: h.moon ?? "" })}
      </p>
      <p className="text-sm text-muted">{t("ruleUsed", { rule: mangal.rule })}</p>
      <PendingReview status={reviewStatus} />
    </Card>
  );
}

export function KaalSarpResult({
  ks,
  reviewStatus,
}: {
  ks: Doshas["kaal_sarp"];
  reviewStatus: string;
}) {
  const t = useTranslations("toolsUi.result");
  return (
    <Card title={t("kaalSarp")}>
      <p className="text-xl font-semibold">{ks.present ? t("present") : t("notPresent")}</p>
      {ks.direction && <p>{t(`kaalSarpDirection.${ks.direction}`)}</p>}
      {ks.type && <p>{t("kaalSarpType", { type: ks.type })}</p>}
      <p className="text-sm text-muted">{t("ruleUsed", { rule: ks.rule })}</p>
      <PendingReview status={reviewStatus} />
    </Card>
  );
}

export function SadeSatiResult({
  ss,
  tz,
  reviewStatus,
}: {
  ss: Doshas["sade_sati"];
  tz: string;
  reviewStatus: string;
}) {
  const t = useTranslations("toolsUi.result");
  const n = useAstroNames();
  const phase = (p: string) => (t.has(`phase.${p}`) ? t(`phase.${p}`) : p);
  return (
    <Card title={t("sadeSati")}>
      <p className="text-xl font-semibold">
        {ss.current_phase
          ? t("sadeSatiActive", {
              phase: phase(ss.current_phase.phase),
              start: n.date(ss.current_phase.start, tz),
              end: n.date(ss.current_phase.end, tz),
            })
          : t("sadeSatiInactive")}
      </p>
      <h4 className="mt-3 font-medium">{t("sadeSatiCycles")}</h4>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {ss.cycles.map((c) => (
          <li key={c.start}>
            {n.date(c.start, tz)} – {n.date(c.end, tz)}
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">{t("ruleUsed", { rule: ss.rule })}</p>
      <PendingReview status={reviewStatus} />
    </Card>
  );
}

export function NumberResult({
  kind,
  numerology,
}: {
  kind: "mulank" | "bhagyank" | "name_number";
  numerology: Numerology;
}) {
  const t = useTranslations("toolsUi.result");
  const n = useAstroNames();
  const title =
    kind === "mulank" ? t("mulank") : kind === "bhagyank" ? t("bhagyank") : t("nameNumber");
  if (kind === "name_number") {
    const r = numerology.name_number;
    if (!r) return null;
    return (
      <Card title={title}>
        <p className="text-4xl font-semibold">{r.number}</p>
        <p>
          {t("planet")}: {n.graha(r.planet)}
        </p>
        <p>{t("compound", { compound: r.compound, number: r.number })}</p>
        <h4 className="font-medium">{t("letters")}</h4>
        <p className="flex flex-wrap gap-2 text-sm">
          {r.letters.map((l, i) => (
            <span key={`${l.letter}-${i}`} className="rounded-sm border border-border px-2 py-0.5">
              {l.letter} = {l.value}
            </span>
          ))}
        </p>
        <PendingReview status={numerology.review_status} />
      </Card>
    );
  }
  const r = kind === "mulank" ? numerology.mulank : numerology.bhagyank;
  if (!r) return null;
  return (
    <Card title={title}>
      <p className="text-4xl font-semibold">{r.number}</p>
      <p>
        {t("planet")}: {n.graha(r.planet)}
      </p>
      <p className="text-sm">
        {t("steps")}: <span className="font-mono">{r.steps}</span>
      </p>
      <PendingReview status={numerology.review_status} />
    </Card>
  );
}
