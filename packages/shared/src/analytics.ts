import schema from "../analytics/events.json" with { type: "json" };
import { isLocale, type Locale } from "./locales";

type PropSpec =
  | { type: "enum"; values: string[]; required?: boolean }
  | { type: "integer" | "boolean" | "slug" | "path"; required?: boolean };

interface EventSpec {
  description: string;
  properties: Record<string, PropSpec>;
}

const EVENTS = schema.events as unknown as Record<string, EventSpec>;
export const ANALYTICS_SCHEMA_VERSION = schema.version;
export type EventName = keyof typeof schema.events;
export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

const SLUG = /^[a-z0-9-]{1,80}$/;
const PATH = /^\/[a-z0-9/_-]{0,199}$/;
const MAX_INT = 1e12;

export interface AnalyticsEvent {
  event: EventName;
  ts: string;
  anonymous_id: string;
  user_id: string | null;
  locale: Locale;
  schema_version: number;
  properties: Record<string, string | number | boolean>;
}

export type ValidationResult =
  { ok: true; event: AnalyticsEvent } | { ok: false; errors: string[] };

function checkProp(spec: PropSpec, value: unknown): boolean {
  switch (spec.type) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "integer":
      return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_INT;
    case "boolean":
      return typeof value === "boolean";
    case "slug":
      return typeof value === "string" && SLUG.test(value);
    case "path":
      return typeof value === "string" && PATH.test(value);
  }
}

/** Validate an event. Unknown events and unknown properties are rejected, not dropped silently. */
export function validateEvent(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) return { ok: false, errors: ["not an object"] };
  const e = input as Record<string, unknown>;

  const spec = typeof e.event === "string" ? EVENTS[e.event] : undefined;
  if (!spec) errors.push(`unknown event: ${String(e.event)}`);
  if (typeof e.ts !== "string" || !/Z$/.test(e.ts) || Number.isNaN(Date.parse(e.ts)))
    errors.push("ts must be an ISO-8601 UTC instant ending in Z");
  if (typeof e.anonymous_id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(e.anonymous_id))
    errors.push("anonymous_id invalid");
  if (
    e.user_id !== null &&
    (typeof e.user_id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.user_id))
  )
    errors.push("user_id must be an opaque id or null");
  if (typeof e.locale !== "string" || !isLocale(e.locale)) errors.push("locale invalid");
  if (e.schema_version !== ANALYTICS_SCHEMA_VERSION) errors.push("schema_version mismatch");

  const props = e.properties;
  if (typeof props !== "object" || props === null || Array.isArray(props)) {
    errors.push("properties must be an object");
  } else if (spec) {
    const p = props as Record<string, unknown>;
    for (const key of Object.keys(p)) {
      const ps = spec.properties[key];
      if (!ps) errors.push(`unknown property: ${key}`);
      else if (!checkProp(ps, p[key])) errors.push(`invalid value for ${key}`);
    }
    for (const [key, ps] of Object.entries(spec.properties)) {
      if (ps.required && !(key in p)) errors.push(`missing property: ${key}`);
    }
  }

  return errors.length
    ? { ok: false, errors }
    : { ok: true, event: e as unknown as AnalyticsEvent };
}
