import { GENDER_IDS, LANGUAGE_IDS, SKILL_IDS, TAXONOMY } from "./taxonomy";
import type { ApplicationInput } from "./types";

/** Price bounds across all tiers; the admin sets the final tier and price on approval. */
export const MIN_PRICE_PAISE = Math.min(...TAXONOMY.tiers.map((t) => t.min_price_per_min_paise));
export const MAX_PRICE_PAISE = Math.max(...TAXONOMY.tiers.map((t) => t.max_price_per_min_paise));

/** Light validation mirrored from the API contract; the API is authoritative. Returns field codes. */
export function validateApplication(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return ["invalid_body"];
  const a = input as Partial<ApplicationInput> & Record<string, unknown>;
  const errors: string[] = [];
  const name = typeof a.display_name === "string" ? a.display_name.trim() : "";
  if (name.length < 2 || name.length > 60) errors.push("display_name");
  const bio = typeof a.bio === "string" ? a.bio.trim() : "";
  if (bio.length < 50 || bio.length > 2000) errors.push("bio");
  if (a.bio_hi !== undefined && (typeof a.bio_hi !== "string" || a.bio_hi.length > 2000))
    errors.push("bio_hi");
  const skills = Array.isArray(a.skills) ? a.skills : [];
  if (!skills.length || skills.length > 5 || !skills.every((s) => SKILL_IDS.includes(String(s))))
    errors.push("skills");
  const langs = Array.isArray(a.languages) ? a.languages : [];
  if (!langs.length || langs.length > 6 || !langs.every((s) => LANGUAGE_IDS.includes(String(s))))
    errors.push("languages");
  if (!GENDER_IDS.includes(String(a.gender))) errors.push("gender");
  const exp = a.experience_years;
  if (typeof exp !== "number" || !Number.isInteger(exp) || exp < 0 || exp > 70)
    errors.push("experience_years");
  const price = a.requested_price_per_min_paise;
  if (
    typeof price !== "number" ||
    !Number.isInteger(price) ||
    price < MIN_PRICE_PAISE ||
    price > MAX_PRICE_PAISE
  )
    errors.push("requested_price_per_min_paise");
  if (a.accepts_terms !== true) errors.push("accepts_terms");
  return errors;
}
