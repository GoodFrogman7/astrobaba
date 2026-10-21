import { describe, expect, it } from "vitest";
import cases from "../analytics/cases.json" with { type: "json" };
import schema from "../analytics/events.json" with { type: "json" };
import { ANALYTICS_SCHEMA_VERSION, EVENT_NAMES, validateEvent } from "../src/analytics";

const base = {
  ts: "2026-10-20T10:00:00Z",
  anonymous_id: "anon_12345678",
  user_id: null,
  locale: "en",
  schema_version: ANALYTICS_SCHEMA_VERSION,
};

describe("analytics schema", () => {
  it("has no free-text property type, so chat content cannot be sent", () => {
    const allowed = new Set(Object.keys(schema.propertyTypes));
    expect([...allowed].sort()).toEqual(["boolean", "enum", "integer", "path", "slug"]);
    for (const ev of Object.values(schema.events))
      for (const p of Object.values(ev.properties as Record<string, { type: string }>))
        expect(allowed.has(p.type)).toBe(true);
  });

  it("has no property named like PII or message content", () => {
    const banned = new Set(
      "message body text content chat transcript question answer phone mobile email name dob place address lat lon ip".split(
        " ",
      ),
    );
    for (const ev of Object.values(schema.events))
      for (const key of Object.keys(ev.properties))
        expect(
          key.split("_").filter((part) => banned.has(part)),
          key,
        ).toEqual([]);
  });

  it("accepts a valid funnel event", () => {
    const r = validateEvent({
      ...base,
      event: "tool_completed",
      properties: { tool: "kundli", unknown_birth_time: false },
    });
    expect(r.ok).toBe(true);
  });

  it("rejects unknown events and unknown properties", () => {
    expect(validateEvent({ ...base, event: "chat_message", properties: {} }).ok).toBe(false);
    const r = validateEvent({
      ...base,
      event: "page_view",
      properties: { path: "/", message: "hello" },
    });
    expect(r).toEqual({ ok: false, errors: ["unknown property: message"] });
  });

  it("rejects paths with query strings (they can carry PII)", () => {
    const r = validateEvent({
      ...base,
      event: "page_view",
      properties: { path: "/kundli?name=Asha" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects phone numbers or emails as user_id", () => {
    expect(
      validateEvent({
        ...base,
        user_id: "+919876543210",
        event: "page_view",
        properties: { path: "/" },
      }).ok,
    ).toBe(false);
    expect(
      validateEvent({ ...base, user_id: "a@b.com", event: "page_view", properties: { path: "/" } })
        .ok,
    ).toBe(false);
  });

  it("requires required properties and correct types", () => {
    expect(
      validateEvent({ ...base, event: "session_ended", properties: { session_type: "chat" } }).ok,
    ).toBe(false);
    expect(
      validateEvent({
        ...base,
        event: "recharge_succeeded",
        properties: { amount_paise: 199.5, is_first_recharge: true },
      }).ok,
    ).toBe(false);
  });

  it("exports every event name", () => {
    expect(EVENT_NAMES).toContain("session_ended");
  });
});

describe("shared validation cases (also run by the Python validator)", () => {
  it.each(cases.cases)("$name", (c) => {
    expect(validateEvent({ ...cases.base, ...c.event }).ok).toBe(c.valid);
  });
});
