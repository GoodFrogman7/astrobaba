import { formatClockOnDay } from "./dates";
import { type Area, grahaName, houseOrdinal, type Loc, signName } from "./names";
import type { HoroscopeFacts } from "./types";

/**
 * Deterministic sentences that restate engine facts in plain language. This is template code,
 * not generated prose: every sentence maps one-to-one to a value in the facts response.
 */
const AREA_NAME: Record<Loc, Record<Area, string>> = {
  en: {
    overall: "overall",
    love: "love and relationships",
    career: "career",
    money: "money",
    health: "health and energy",
  },
  hi: {
    overall: "समग्र",
    love: "प्रेम और संबंध",
    career: "करियर",
    money: "धन",
    health: "स्वास्थ्य और ऊर्जा",
  },
};

export const SCORE_LABEL: Record<Loc, Record<string, string>> = {
  en: {
    challenging: "challenging",
    mixed: "mixed",
    steady: "steady",
    good: "good",
    excellent: "excellent",
  },
  hi: {
    challenging: "चुनौतीपूर्ण",
    mixed: "मिश्रित",
    steady: "स्थिर",
    good: "अच्छा",
    excellent: "उत्तम",
  },
};

export function scoreText(score: number, label: string, locale: Loc): string {
  return locale === "hi"
    ? `5 में से ${score} · ${SCORE_LABEL.hi[label] ?? label}`
    : `${score} of 5 · ${SCORE_LABEL.en[label] ?? label}`;
}

export function areaSentences(facts: HoroscopeFacts, area: Area, locale: Loc): string[] {
  const a = facts.areas[area];
  const sign = signName(facts.sign, locale);
  const list = (effect: "favourable" | "challenging") =>
    a.reasons
      .filter((r) => r.effect === effect)
      .map((r) =>
        locale === "hi"
          ? `${grahaName(r.graha, "hi")} ${houseOrdinal(r.house_from_sign, "hi")} भाव में`
          : `${grahaName(r.graha, "en")} in the ${houseOrdinal(r.house_from_sign, "en")} house`,
      );
  const good = list("favourable");
  const hard = list("challenging");
  const out: string[] = [];
  if (locale === "hi") {
    out.push(
      `${sign} राशि के लिए ${AREA_NAME.hi[area]} का अंक ${scoreText(a.score, a.label, "hi")} है। यह ${sign} से गिने गए भावों में ग्रहों की स्थिति पर तय गोचर नियम लगाकर निकाला गया है।`,
    );
    if (good.length) out.push(`अनुकूल स्थितियाँ: ${good.join(", ")}।`);
    if (hard.length) out.push(`चुनौतीपूर्ण स्थितियाँ: ${hard.join(", ")}।`);
  } else {
    out.push(
      `For ${sign}, the ${AREA_NAME.en[area]} score is ${scoreText(a.score, a.label, "en")}. It comes from fixed transit rules applied to the house each planet occupies, counted from ${sign}.`,
    );
    if (good.length) out.push(`Favourable placements: ${good.join(", ")}.`);
    if (hard.length) out.push(`Challenging placements: ${hard.join(", ")}.`);
  }
  return out;
}

export function moonSentences(facts: HoroscopeFacts, locale: Loc): string[] {
  const out: string[] = [];
  const startSign = signName(facts.moon.start.sign, locale);
  out.push(
    locale === "hi"
      ? `अवधि की शुरुआत में चंद्रमा ${startSign} राशि में है।`
      : `At the start of the period the Moon is in ${startSign}.`,
  );
  for (const ing of facts.moon.ingresses) {
    const when = formatClockOnDay(ing.at, "Asia/Kolkata", facts.window.start_ist_date, locale);
    out.push(
      locale === "hi"
        ? `चंद्रमा ${when} IST पर ${signName(ing.to_sign, "hi")} राशि में प्रवेश करता है।`
        : `The Moon moves into ${signName(ing.to_sign, "en")} at ${when} IST.`,
    );
  }
  return out;
}
