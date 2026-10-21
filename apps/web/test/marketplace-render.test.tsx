import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next-intl's Link needs the Next router; a plain anchor is enough for markup assertions.
vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ push: () => undefined }),
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string | { pathname: string; query?: Record<string, string> };
    children: ReactNode;
  }) => {
    const url =
      typeof href === "string"
        ? href
        : `${href.pathname}${href.query ? `?${new URLSearchParams(href.query)}` : ""}`;
    return (
      <a href={url} {...rest}>
        {children}
      </a>
    );
  },
}));
import enCore from "../messages/en.json" with { type: "json" };
import enMarket from "../messages/en/marketplace.json" with { type: "json" };
import enBilling from "../messages/en/billing.json" with { type: "json" };
import hiCore from "../messages/hi.json" with { type: "json" };
import hiMarket from "../messages/hi/marketplace.json" with { type: "json" };
import hiBilling from "../messages/hi/billing.json" with { type: "json" };
import { AstrologerCard } from "../src/components/marketplace/AstrologerCard";
import { ConsultCard, MobileConsultBar } from "../src/components/marketplace/ConsultCard";
import { EmptyState } from "../src/components/marketplace/EmptyState";
import { FilterForm } from "../src/components/marketplace/FilterForm";
import { ProfileBio, ProfileHeader } from "../src/components/marketplace/ProfileHeader";
import { ReviewList } from "../src/components/marketplace/ReviewList";
import { parseFilters } from "../src/lib/marketplace/filters";
import type {
  AstrologerCard as Card,
  AstrologerProfile,
  ReviewsResponse,
} from "../src/lib/marketplace/types";
import list from "./fixtures/marketplace/list.json" with { type: "json" };
import profileFx from "./fixtures/marketplace/profile.json" with { type: "json" };
import reviewsFx from "./fixtures/marketplace/reviews.json" with { type: "json" };

const [demo, fresh] = list.items as unknown as Card[];
const profile = profileFx as unknown as AstrologerProfile;
const reviews = reviewsFx as unknown as ReviewsResponse;

function render(node: ReactNode, locale: "en" | "hi" = "en") {
  const messages =
    locale === "en"
      ? { ...enCore, ...enMarket, ...enBilling }
      : { ...hiCore, ...hiMarket, ...hiBilling };
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("directory cards", () => {
  it("shows name, skills, languages, price, rating, presence and wait time", () => {
    const html = render(<AstrologerCard a={demo!} />);
    expect(html).toContain("Demo Astrologer 01");
    expect(html).toContain("Vedic astrology · KP system");
    expect(html).toContain("Hindi, English");
    expect(html).toContain("₹45/min");
    expect(html).toContain("4.6");
    expect(html).toContain("18 reviews");
    expect(html).toContain("In a session");
    expect(html).toContain("About 7 min wait");
    expect(html).toContain("Demo profile");
    expect(html).toContain('href="/astrologers/demo-astrologer-01"');
  });

  it("never invents a wait time or a rating", () => {
    const html = render(<AstrologerCard a={fresh!} />);
    expect(html).toContain("In a session");
    expect(html).not.toMatch(/min wait/);
    expect(html).toContain(">New<");
    expect(html).not.toContain("Demo profile");
  });

  it("hides presence where data may be cached (expert cards)", () => {
    const html = render(<AstrologerCard a={demo!} showPresence={false} />);
    expect(html).not.toContain("In a session");
  });

  it("renders taxonomy names in Hindi", () => {
    const html = render(<AstrologerCard a={demo!} />, "hi");
    expect(html).toContain("वैदिक ज्योतिष · केपी पद्धति");
    expect(html).toContain("हिन्दी, अंग्रेज़ी");
    expect(html).toContain("डेमो प्रोफ़ाइल");
  });
});

describe("directory chrome", () => {
  it("empty state is honest: no numbers, links to apply", () => {
    const html = render(<EmptyState />);
    expect(html).toContain("Astrologers are joining");
    expect(html).not.toMatch(/\d+\s*(astrologers|online)/i);
    expect(html).toContain('href="/astrologers/apply"');
  });

  it("filter form is a plain GET form that keeps the current choices", () => {
    const html = render(
      <FilterForm filters={parseFilters({ skill: "kp", online: "1", sort: "rating" })} />,
    );
    const form = html.match(/<form[^>]*>/)?.[0] ?? "";
    expect(form).toContain('method="get"');
    expect(form).toContain('action="/astrologers"');
    const input = (name: string, value: string) =>
      (html.match(/<input[^>]*>/g) ?? []).find(
        (t) => t.includes(`name="${name}"`) && t.includes(`value="${value}"`),
      ) ?? "";
    expect(input("skill", "kp")).toContain('checked=""');
    expect(input("skill", "vedic")).not.toContain("checked");
    expect(input("online", "1")).toContain('checked=""');
    expect(html).toMatch(/<details open=""/);
    const hi = render(<FilterForm filters={parseFilters({})} />, "hi");
    expect(hi).toMatch(/action="\/hi\/astrologers"/);
    expect(hi).not.toMatch(/<details open=""/);
  });
});

describe("profile", () => {
  it("shows verification, presence, price and bio as text", () => {
    const html = render(
      <>
        <ProfileHeader p={profile} />
        <ProfileBio p={profile} />
        <ConsultCard p={profile} />
      </>,
    );
    expect(html).toContain("Identity checked");
    expect(html).toContain("Qualifications checked");
    expect(html).toContain("Interview passed");
    expect(html).toContain("Online");
    expect(html).toContain("₹12.50/min");
    expect(html).toContain("September 2026");
    expect(html).not.toContain("demo profile for development");
  });

  it("chat starts from the card; calls are off for this astrologer and say so", () => {
    const html = render(<ConsultCard p={profile} />);
    // Chat button is live, with the minimum balance spelled out (2 min × ₹12.50).
    expect(html).toMatch(/<button type="button" class="[^"]*w-full[^"]*">Chat<\/button>/);
    expect(html).toContain(
      "You need at least ₹25 in your wallet to start a chat or call (2 minutes).",
    );
    expect(html).toContain("Voice calls are not available with this astrologer right now.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Call<\/button>/);
    expect(html).not.toContain("later release");
    // No free offer until the wallet (client-side) says the user is eligible.
    expect(html).not.toContain("Free chat");
    const off = render(
      <ConsultCard p={{ ...profile, consult: { chat_enabled: false, call_enabled: false } }} />,
    );
    expect(off).toContain("Chat is not available with this astrologer right now.");
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Chat<\/button>/);
    expect(off).not.toContain("You need at least");
  });

  it("the Call button is live when the astrologer takes calls, at the same price", () => {
    const p = { ...profile, consult: { chat_enabled: true, call_enabled: true } };
    const html = render(<ConsultCard p={p} />);
    expect(html).toMatch(/<button type="button" class="[^"]*w-full[^"]*">Chat<\/button>/);
    expect(html).toMatch(/<button type="button" class="[^"]*w-full[^"]*">Call<\/button>/);
    expect(html).not.toContain("Voice calls are not available");
    expect(html).toContain("₹12.50");
    const bar = render(<MobileConsultBar p={p} />);
    expect(bar).toMatch(/<button type="button" class="[^"]*">Call<\/button>/);
    const hi = render(<ConsultCard p={p} />, "hi");
    expect(hi).toMatch(/>कॉल करें<\/button>/);
    // Calls only: chat stays off and says so; the call needs the same minimum balance.
    const callOnly = render(
      <ConsultCard p={{ ...profile, consult: { chat_enabled: false, call_enabled: true } }} />,
    );
    expect(callOnly).toMatch(/<button[^>]*disabled=""[^>]*>Chat<\/button>/);
    expect(callOnly).toMatch(/<button type="button" class="[^"]*">Call<\/button>/);
    expect(callOnly).toContain("You need at least ₹25");
  });

  it("shows the usual schedule in IST, merged by day, only when there are slots", () => {
    const p: AstrologerProfile = {
      ...profile,
      availability: {
        timezone: "Asia/Kolkata",
        slots: [
          { weekday: 6, start: "10:00", end: "12:00" },
          { weekday: 0, start: "17:00", end: "20:30" },
          { weekday: 1, start: "17:00", end: "20:30" },
          { weekday: 2, start: "17:00", end: "20:30" },
          { weekday: 0, start: "09:00", end: "12:00" },
        ],
      },
    };
    const html = render(<ProfileHeader p={p} />);
    expect(html).toContain("Usually available (IST)");
    expect(html).toContain(
      '<dt class="text-muted"><span aria-hidden="true">Mon</span><span class="sr-only">Monday</span></dt><dd class="tabular-nums">9:00 am – 12:00 pm, 5:00 pm – 8:30 pm</dd>',
    );
    expect(html).toContain('<span aria-hidden="true">Tue, Wed</span>');
    expect(html).toContain("Tuesday and Wednesday");
    expect(html).toContain('<span aria-hidden="true">Sun</span>');
    expect(html.indexOf(">Mon<")).toBeLessThan(html.indexOf(">Sun<"));
    const hi = render(<ProfileHeader p={p} />, "hi");
    expect(hi).toContain("आम तौर पर उपलब्ध (IST)");
    expect(hi).toContain("मंगलवार और बुधवार");
    expect(hi).toContain(">सोम<");
    for (const none of [undefined, null, { timezone: "Asia/Kolkata" as const, slots: [] }]) {
      const empty = render(<ProfileHeader p={{ ...profile, availability: none }} />);
      expect(empty).not.toContain("Usually available");
      expect(empty).not.toContain('data-testid="availability"');
    }
  });

  it("Hindi page notes when the bio is only in English", () => {
    const html = render(<ProfileBio p={profile} />, "hi");
    expect(html).toContain("इस ज्योतिषी ने अपनी प्रोफ़ाइल अंग्रेज़ी में लिखी है।");
    const withHi = render(<ProfileBio p={{ ...profile, bio_hi: "नमस्ते" }} />, "hi");
    expect(withHi).toContain("नमस्ते");
    expect(withHi).not.toContain("अंग्रेज़ी में लिखी");
  });

  it("demo profiles say so plainly", () => {
    const html = render(<ProfileHeader p={{ ...profile, is_demo: true }} />);
    expect(html).toContain("This is a demo profile for development. It is not a real astrologer.");
  });

  it("reviews escape user text and show replies and load-more", () => {
    const html = render(
      <ReviewList
        slug="meera-joshi"
        name="Meera Joshi"
        reviews={reviews.items}
        rating={reviews.rating}
        nextCursor={reviews.next_cursor}
      />,
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Reply from Meera Joshi");
    expect(html).toContain("Thank you!");
    expect(html).toContain("4.5 out of 5 from 2 reviews");
    expect(html).toContain('href="/astrologers/meera-joshi?reviews=cj0y"');
  });

  it("no reviews yet explains who can review", () => {
    const html = render(
      <ReviewList
        slug="x"
        name="X"
        reviews={[]}
        rating={{ average: null, count: 0 }}
        nextCursor={null}
      />,
    );
    expect(html).toContain(
      "Reviews can only be written by clients after a completed consultation.",
    );
  });
});
