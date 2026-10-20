/** Subset of the astro engine's POST /v1/kundli response that the charts need. */
export type GrahaId =
  "sun" | "moon" | "mars" | "mercury" | "jupiter" | "venus" | "saturn" | "rahu" | "ketu";

export interface ChartGraha {
  id: GrahaId;
  sign_index: number; // 0 = Aries … 11 = Pisces (sidereal)
  degree_in_sign: number;
  retrograde: boolean;
  house?: number;
}

export interface KundliChartData {
  birth?: { utc: string; tz: string; unknown_time: boolean };
  ascendant: { sign_index: number; degree_in_sign: number } | null;
  grahas: ChartGraha[];
  houses: { house: number; sign_index: number; occupants: GrahaId[] }[] | null;
}

export type ChartLocale = "en" | "hi";

export interface ChartProps {
  data: KundliChartData;
  locale: ChartLocale;
  /** Accessible name override; defaults to the localised chart title. */
  title?: string;
}
