import type { ReportCtx } from "@/lib/report/context";
import type { Numerology } from "@/lib/tools/types";
import { Facts, H3, HowTo, ReviewNote, Section } from "./parts";

export function NumerologySection({ c, n, name }: { c: ReportCtx; n: Numerology; name: string }) {
  const nn = n.name_number;
  return (
    <Section id="numerology" title={c.t("numerology.heading")}>
      <HowTo c={c} paras={c.paras("numerology.howTo")} />
      <div className="r-cards r-cards-2">
        {(["mulank", "bhagyank"] as const).map((kind) => {
          const r = n[kind];
          if (!r) return null;
          return (
            <div key={kind} className="r-card r-keep" data-number={kind}>
              <H3>{c.tr(kind)}</H3>
              <p className="r-big">{r.number}</p>
              <Facts
                rows={[
                  [c.tr("planet"), c.graha(r.planet)],
                  [
                    c.tr("steps"),
                    <span key="s" className="r-num">
                      {r.steps}
                    </span>,
                  ],
                ]}
              />
            </div>
          );
        })}
      </div>
      <div className="r-card r-keep" data-number="name_number">
        <H3>{c.tr("nameNumber")}</H3>
        <p className="r-small r-muted">{c.t("numerology.nameUsed", { name })}</p>
        {nn ? (
          <>
            <p className="r-big">{nn.number}</p>
            <Facts
              rows={[
                [c.tr("planet"), c.graha(nn.planet)],
                [c.tr("steps"), c.tr("compound", { compound: nn.compound, number: nn.number })],
                [
                  c.tr("letters"),
                  <span key="l" className="r-letters">
                    {nn.letters.map((l, i) => (
                      <span key={`${l.letter}-${i}`}>
                        {l.letter} = {l.value}
                      </span>
                    ))}
                  </span>,
                ],
              ]}
            />
          </>
        ) : (
          <p className="r-note">{c.t("numerology.nameMissing")}</p>
        )}
      </div>
      <ReviewNote c={c} status={n.review_status} />
    </Section>
  );
}
