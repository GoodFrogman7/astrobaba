import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import enCore from "../messages/en.json" with { type: "json" };
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiMarket from "../messages/hi/marketplace.json" with { type: "json" };
import {
  ApplicationForm,
  applicationBody,
  applicationErrors,
  inviteFromSearch,
} from "../src/components/marketplace/ApplicationForm";
import type { ApplicationInput } from "../src/lib/marketplace/types";

const INPUT: ApplicationInput = {
  display_name: "Asha Verma",
  bio: "Vedic astrologer with a calm, practical approach to chart reading and remedies.",
  skills: ["vedic"],
  languages: ["hi", "en"],
  gender: "female",
  experience_years: 12,
  requested_price_per_min_paise: 2500,
  accepts_terms: true,
};

function render(node: ReactNode, locale: "en" | "hi" = "en") {
  const messages = locale === "en" ? { ...enCore, ...enMarket } : { ...hiCore, ...hiMarket };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("invite links", () => {
  it("reads ?invite= from the address", () => {
    expect(inviteFromSearch("?invite=ABCD2345WXYZ")).toBe("ABCD2345WXYZ");
    expect(inviteFromSearch("?utm_source=x&invite=abcd-2345 wxyz")).toBe("ABCD2345WXYZ");
    expect(inviteFromSearch(new URLSearchParams({ invite: "abcd2345wxyz" }))).toBe("ABCD2345WXYZ");
    expect(inviteFromSearch("")).toBe("");
    expect(inviteFromSearch("?other=1")).toBe("");
    expect(inviteFromSearch(`?invite=${"A".repeat(500)}`)).toHaveLength(64);
  });

  it("sends invite_code only when there is one", () => {
    expect(applicationBody(INPUT, "ABCD2345WXYZ")).toEqual({
      ...INPUT,
      invite_code: "ABCD2345WXYZ",
    });
    expect(applicationBody(INPUT, "  ")).toEqual(INPUT);
    expect("invite_code" in applicationBody(INPUT, "")).toBe(false);
  });

  it("maps the API's invite errors to their own messages", () => {
    expect(applicationErrors(403, { code: "invite_required" })).toEqual(["invite_required"]);
    expect(applicationErrors(422, { code: "invite_invalid" })).toEqual(["invite_invalid"]);
    expect(applicationErrors(409, { code: "already_applied" })).toEqual(["already_applied"]);
    expect(applicationErrors(422, { code: "invalid_fields", fields: ["bio"] })).toEqual(["bio"]);
    expect(applicationErrors(503, { code: "upstream_unavailable" })).toEqual(["generic"]);
    expect(applicationErrors(403, { code: "forbidden" })).toEqual(["generic"]);
  });

  it("has English and Hindi copy for both invite errors", () => {
    for (const messages of [enMarket, hiMarket]) {
      const form = messages.market.apply.form as Record<string, unknown> & {
        errors: Record<string, string>;
      };
      expect(form.invite).toBeTruthy();
      expect(form.inviteHint).toBeTruthy();
      expect(form.errors.invite_required).toBeTruthy();
      expect(form.errors.invite_invalid).toBeTruthy();
    }
    expect(hiMarket.market.apply.form.errors.invite_invalid).not.toBe(
      enMarket.market.apply.form.errors.invite_invalid,
    );
  });

  it("renders the invite field prefilled, in both languages", () => {
    const en = render(<ApplicationForm onDone={() => undefined} invite="ABCD2345WXYZ" />);
    expect(en).toContain('name="invite_code"');
    expect(en).toContain('value="ABCD2345WXYZ"');
    expect(en).toContain(enMarket.market.apply.form.invite);
    const hi = render(<ApplicationForm onDone={() => undefined} invite="" />, "hi");
    expect(hi).toContain(hiMarket.market.apply.form.invite);
    expect(hi).toContain('value=""');
  });
});
