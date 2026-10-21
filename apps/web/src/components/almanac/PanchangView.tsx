import { getTranslations } from "next-intl/server";
import { formatClockOnDay } from "@/lib/almanac/dates";
import { grahaName, type Loc } from "@/lib/almanac/names";
import type { NamedSpan, Panchang } from "@/lib/almanac/types";

// Token colours; the word is always shown too, so meaning never depends on colour.
const NATURE_COLOR = {
  good: "var(--color-success)",
  neutral: "var(--color-fg)",
  bad: "var(--color-danger)",
} as const;

/** Full panchang for one place and date. Every time is shown in the place's own zone. */
export async function PanchangView({
  data,
  locale,
  city,
}: {
  data: Panchang;
  locale: Loc;
  city: string;
}) {
  const t = await getTranslations({ locale, namespace: "almanac.panchang" });
  const tz = data.place.tz;
  const at = (iso: string) => formatClockOnDay(iso, tz, data.date, locale);
  const name = (s: { en: string; hi: string }) => (locale === "hi" ? s.hi : s.en);

  const spanRows = (kind: string, items: NamedSpan[], extra?: (s: NamedSpan) => string | null) => (
    <ul className="space-y-1">
      {items.map((s) => (
        <li key={`${kind}-${s.start}`}>
          <span className="font-medium">{name(s)}</span>
          {extra?.(s) ? <span className="text-muted"> · {extra(s)}</span> : null}{" "}
          <span className="text-muted">{t("until", { time: at(s.end) })}</span>
          {s.kshaya ? (
            <p className="text-sm text-muted">{t("kshaya", { kind: t(`kind.${kind}`) })}</p>
          ) : null}
          {s.vriddhi ? (
            <p className="text-sm text-muted">{t("vriddhi", { kind: t(`kind.${kind}`) })}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-8">
      <section
        aria-labelledby="pc-summary"
        className="rounded-md border border-border bg-surface p-5"
      >
        <h2 id="pc-summary" className="text-lg font-semibold">
          {t("summary")}
        </h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted">{t("vaara")}</dt>
            <dd className="font-medium">{name(data.vaara)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">
              {t("sunrise")} / {t("sunset")}
            </dt>
            <dd className="font-medium">
              {at(data.sunrise)} / {at(data.sunset)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t("rahuKaal")}</dt>
            <dd className="font-medium">
              {at(data.rahu_kaal.start)} – {at(data.rahu_kaal.end)}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t("tithi")}</dt>
            <dd>
              {spanRows("tithi", data.tithis, (s) =>
                "paksha" in s
                  ? t(`paksha.${(s as { paksha: "shukla" | "krishna" }).paksha}`)
                  : null,
              )}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t("nakshatra")}</dt>
            <dd>{spanRows("nakshatra", data.nakshatras)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t("yoga")}</dt>
            <dd>{spanRows("yoga", data.yogas)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t("karana")}</dt>
            <dd>{spanRows("karana", data.karanas)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-sm text-muted">{t("timesNote", { city, tz })}</p>
      </section>

      {data.choghadiya && (
        <section aria-labelledby="pc-chog">
          <h2 id="pc-chog" className="text-lg font-semibold">
            {t("choghadiya")}
          </h2>
          <div className="mt-3 grid gap-6 sm:grid-cols-2">
            {(["day", "night"] as const).map((part) => (
              <table key={part} className="w-full text-sm">
                <caption className="mb-2 text-left font-medium">
                  {t(part === "day" ? "dayChoghadiya" : "nightChoghadiya")}
                </caption>
                <thead>
                  <tr className="border-b border-border text-left text-muted">
                    <th scope="col" className="py-1 pr-2 font-normal">
                      {t("period")}
                    </th>
                    <th scope="col" className="py-1 pr-2 font-normal">
                      {t("name")}
                    </th>
                    <th scope="col" className="py-1 font-normal">
                      {t("nature.good")} / {t("nature.bad")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.choghadiya![part].map((c) => (
                    <tr key={c.start} className="border-b border-border/60">
                      <td className="py-1 pr-2 tabular-nums">
                        {at(c.start)}–{at(c.end)}
                      </td>
                      <td className="py-1 pr-2">{name(c)}</td>
                      <td className="py-1" style={{ color: NATURE_COLOR[c.nature] }}>
                        {t(`nature.${c.nature}`)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        </section>
      )}

      {data.hora && (
        <section aria-labelledby="pc-hora">
          <h2 id="pc-hora" className="text-lg font-semibold">
            {t("hora")}
          </h2>
          <details className="mt-3 rounded-md border border-border bg-surface p-4">
            <summary className="cursor-pointer font-medium">{t("horaShow")}</summary>
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted">
                  <th scope="col" className="py-1 pr-2 font-normal">
                    #
                  </th>
                  <th scope="col" className="py-1 pr-2 font-normal">
                    {t("period")}
                  </th>
                  <th scope="col" className="py-1 font-normal">
                    {t("lord")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.hora.map((h) => (
                  <tr key={h.number} className="border-b border-border/60">
                    <td className="py-1 pr-2 tabular-nums">
                      {h.number} · {t(`part.${h.part}`)}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {at(h.start)}–{at(h.end)}
                    </td>
                    <td className="py-1">{grahaName(h.lord, locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </section>
      )}
    </div>
  );
}
