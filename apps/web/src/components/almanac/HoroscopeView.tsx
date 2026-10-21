import { getTranslations } from "next-intl/server";
import { formatClockOnDay } from "@/lib/almanac/dates";
import {
  AREAS,
  grahaName,
  houseOrdinal,
  type Loc,
  signName,
  weekdayName,
} from "@/lib/almanac/names";
import { areaSentences, moonSentences, scoreText } from "@/lib/almanac/sentences";
import type { HoroscopeFacts, PublishedHoroscope } from "@/lib/almanac/types";
import { ScoreScale } from "./ScoreScale";

/** Scores, published (reviewed) prose or fact sentences, transits and the Moon's movement. */
export async function HoroscopeView({
  facts,
  published,
  locale,
  windowText,
}: {
  facts: HoroscopeFacts;
  published: PublishedHoroscope | null;
  locale: Loc;
  windowText: string;
}) {
  const t = await getTranslations({ locale, namespace: "almanac.horoscope" });
  const sign = signName(facts.sign, locale);
  return (
    <div className="space-y-8">
      <p className="text-sm text-muted">{t("moonSign")}</p>
      <section
        aria-labelledby="hs-scores"
        className="rounded-md border border-border bg-surface p-5"
      >
        <h2 id="hs-scores" className="text-lg font-semibold">
          {t("scores", { window: windowText })}
        </h2>
        <ul className="mt-3 space-y-3">
          {AREAS.map((area) => (
            <li key={area} className="flex flex-wrap items-center justify-between gap-2">
              <span>{t(`areas.${area}`)}</span>
              <ScoreScale
                score={facts.areas[area].score}
                label={t("scoreScale")}
                text={scoreText(facts.areas[area].score, facts.areas[area].label, locale)}
              />
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-muted">{published ? t("reviewed") : t("notPublished")}</p>
      </section>

      {AREAS.map((area) => (
        <section key={area} aria-labelledby={`hs-${area}`}>
          <h2 id={`hs-${area}`} className="text-lg font-semibold">
            {t(`areas.${area}`)}
          </h2>
          {published?.sections?.[area] ? (
            <p className="mt-2 leading-relaxed">{published.sections[area]}</p>
          ) : (
            areaSentences(facts, area, locale).map((s) => (
              <p key={s} className="mt-2 leading-relaxed">
                {s}
              </p>
            ))
          )}
        </section>
      ))}

      <section aria-labelledby="hs-moon">
        <h2 id="hs-moon" className="text-lg font-semibold">
          {t("moon")}
        </h2>
        {moonSentences(facts, locale).map((s) => (
          <p key={s} className="mt-2 leading-relaxed">
            {s}
          </p>
        ))}
      </section>

      <section aria-labelledby="hs-transits">
        <h2 id="hs-transits" className="text-lg font-semibold">
          {t("transits", { sign })}
        </h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-muted">
                <th scope="col" className="py-1 pr-3 font-normal">
                  {t("graha")}
                </th>
                <th scope="col" className="py-1 pr-3 font-normal">
                  {t("sign")}
                </th>
                <th scope="col" className="py-1 pr-3 font-normal">
                  {t("house", { sign })}
                </th>
                <th scope="col" className="py-1 font-normal">
                  {t("retrograde")}
                </th>
              </tr>
            </thead>
            <tbody>
              {facts.transits.map((tr) => (
                <tr key={tr.graha} className="border-b border-border/60">
                  <td className="py-1 pr-3">{grahaName(tr.graha, locale)}</td>
                  <td className="py-1 pr-3">
                    {signName(tr.sign, locale)}
                    {tr.ingresses.map((i) => (
                      <span key={i.at} className="block text-muted">
                        → {signName(i.to_sign, locale)} ·{" "}
                        {formatClockOnDay(
                          i.at,
                          "Asia/Kolkata",
                          facts.window.start_ist_date,
                          locale,
                        )}{" "}
                        IST
                      </span>
                    ))}
                  </td>
                  <td className="py-1 pr-3">{houseOrdinal(tr.house_from_sign, locale)}</td>
                  <td className="py-1">{tr.retrograde ? t("yes") : t("no")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section
        aria-labelledby="hs-lucky"
        className="rounded-md border border-border bg-surface p-5"
      >
        <h2 id="hs-lucky" className="text-lg font-semibold">
          {t("lucky")}
        </h2>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <dt className="text-sm text-muted">{t("luckyDay")}</dt>
            <dd className="font-medium">{weekdayName(facts.lucky.day, locale)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t("luckyNumber")}</dt>
            <dd className="font-medium">{facts.lucky.number}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-muted">{t("review")}</p>
      </section>
    </div>
  );
}
