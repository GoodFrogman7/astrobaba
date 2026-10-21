import taxonomyFile from "../../../../../data/marketplace/taxonomy.json" with { type: "json" };

/** Marketplace taxonomy (data/marketplace/taxonomy.json), shared with the API and admin. */
type Named = { id: string; en: string; hi: string };
export interface Tier extends Named {
  min_price_per_min_paise: number;
  max_price_per_min_paise: number;
}

export const TAXONOMY = taxonomyFile as unknown as {
  skills: Named[];
  languages: Named[];
  genders: Named[];
  tiers: Tier[];
  review: { max_text_chars: number };
  kyc: { max_file_bytes: number; content_types: string[]; max_documents: number };
};

export const SKILL_IDS = TAXONOMY.skills.map((s) => s.id);
export const LANGUAGE_IDS = TAXONOMY.languages.map((s) => s.id);
export const GENDER_IDS = TAXONOMY.genders.map((s) => s.id);
export const TIER_IDS = TAXONOMY.tiers.map((s) => s.id);

const lookup = (list: Named[], id: string, locale: "en" | "hi") =>
  list.find((x) => x.id === id)?.[locale] ?? id;

export const skillName = (id: string, l: "en" | "hi") => lookup(TAXONOMY.skills, id, l);
export const languageName = (id: string, l: "en" | "hi") => lookup(TAXONOMY.languages, id, l);
export const tierName = (id: string, l: "en" | "hi") => lookup(TAXONOMY.tiers, id, l);
