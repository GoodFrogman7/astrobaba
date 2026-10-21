import type { BirthInput } from "./types";

/** Validation shared by the forms (client) and the server actions (server). Returns error codes. */
export function validateBirth(b: Partial<BirthInput> | undefined): string[] {
  const errors: string[] = [];
  if (!b) return ["missing"];
  if (!b.date || !/^\d{4}-\d{2}-\d{2}$/.test(b.date) || Number.isNaN(Date.parse(b.date))) {
    errors.push("date_invalid");
  } else {
    const year = Number(b.date.slice(0, 4));
    if (year < 1800 || year > 2399) errors.push("date_out_of_range");
  }
  if (b.time !== null && b.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) {
    errors.push("time_invalid");
  }
  const p = b.place;
  if (
    !p ||
    !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lon) ||
    Math.abs(p.lat) > 90 ||
    Math.abs(p.lon) > 180 ||
    !p.tz ||
    !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(p.tz)
  ) {
    errors.push("place_required");
  }
  if (b.name !== undefined && b.name.length > 60) errors.push("name_too_long");
  if (b.fold !== undefined && b.fold !== 0 && b.fold !== 1) errors.push("fold_invalid");
  return errors;
}

export function validateDob(dob: string | undefined): string[] {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(Date.parse(dob)))
    return ["date_invalid"];
  return [];
}

/** Latin letters only for now; the engine explains why (numerology tables are Latin). */
export function validateName(name: string | undefined): string[] {
  const n = (name ?? "").trim();
  if (!n) return ["name_required"];
  if (n.length > 60) return ["name_too_long"];
  if (!/^[A-Za-z][A-Za-z .'-]*$/.test(n)) return ["latin_letters_required"];
  return [];
}

/** Engine Birth payload (drops UI-only fields). */
export function toEngineBirth(b: BirthInput) {
  return {
    date: b.date,
    time: b.time,
    place: { lat: b.place.lat, lon: b.place.lon, tz: b.place.tz },
    ...(b.fold !== undefined ? { fold: b.fold } : {}),
  };
}
