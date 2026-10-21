/** Shapes of the engine responses the almanac pages read (services/astro). */
export interface Span {
  start: string;
  end: string;
  kshaya?: boolean;
  vriddhi?: boolean;
}
export interface NamedSpan extends Span {
  id: string;
  en: string;
  hi: string;
  number?: number;
}
export interface TithiSpan extends NamedSpan {
  paksha: "shukla" | "krishna";
}
export interface NakshatraSpan extends NamedSpan {
  lord: string;
}
export interface Choghadiya {
  id: string;
  en: string;
  hi: string;
  planet: string;
  nature: "good" | "neutral" | "bad";
  start: string;
  end: string;
}
export interface Hora {
  number: number;
  lord: string;
  part: "day" | "night";
  start: string;
  end: string;
}
export interface Panchang {
  date: string;
  place: { lat: number; lon: number; tz: string };
  vaara: { id: string; en: string; hi: string };
  sunrise: string;
  sunset: string;
  next_sunrise: string;
  rahu_kaal: { part: number; start: string; end: string };
  tithis: TithiSpan[];
  nakshatras: NakshatraSpan[];
  yogas: NamedSpan[];
  karanas: NamedSpan[];
  choghadiya?: { day: Choghadiya[]; night: Choghadiya[] };
  hora?: Hora[];
  settings: Record<string, unknown>;
}

export interface AreaFacts {
  score: number;
  label: "challenging" | "mixed" | "steady" | "good" | "excellent";
  reasons: {
    graha: string;
    house_from_sign: number;
    effect: "favourable" | "challenging";
    weight: number;
  }[];
}
export interface HoroscopeFacts {
  sign: string;
  period: "daily" | "weekly" | "monthly";
  window: { start_ist_date: string; end_ist_date: string; start: string; end: string };
  transits: {
    graha: string;
    sign: string;
    house_from_sign: number;
    retrograde: boolean;
    ingresses: { at: string; to_sign: string }[];
  }[];
  moon: {
    start: { sign: string; nakshatra: string };
    ingresses: { at: string; to_sign: string }[];
  };
  areas: Record<"overall" | "love" | "career" | "money" | "health", AreaFacts>;
  lucky: { day: string; number: number };
  settings: { rules_review_status?: string } & Record<string, unknown>;
}
export interface PublishedHoroscope {
  sections: Record<"overall" | "love" | "career" | "money" | "health", string>;
  reviewed_at?: string | null;
}
