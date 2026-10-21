import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Next server/client modules stubbed; the guard → API client → headers chain runs for real
// against a mocked fetch. Pages render to static HTML (no DOM needed).
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "ap_astro_session" ? { value: "astro-token" } : undefined),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));

const { consolePage } = await import("../src/lib/guard");
const { SafetyPanel } = await import("../src/components/SafetyPanel");
const { BlockedNotice } = await import("../src/components/BlockedNotice");
const { TermsGatePage } = await import("../src/components/TermsGatePage");
const { normalizeResources } = await import("../src/lib/trust");

/** The real crisis data the API serves (data/safety/helplines.json), not a typed-in copy. */
const helplinesJson = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../data/safety/helplines.json", import.meta.url)),
    "utf8",
  ),
) as unknown;

type Call = { url: string; auth: string | undefined };
let calls: Call[] = [];
let consentsBody: unknown;
let consentsStatus = 200;

beforeEach(() => {
  calls = [];
  consentsStatus = 200;
  consentsBody = {
    version: "2026-10-21",
    required: ["astrologer_terms"],
    accepted: [],
    current: false,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, auth: headers.authorization });
      if (url.endsWith("/v1/me")) {
        return Response.json({
          id: "u1",
          astrologer: { id: "a1", status: "approved", slug: "demo" },
        });
      }
      if (url.endsWith("/v1/me/consents")) {
        return Response.json(consentsBody, { status: consentsStatus });
      }
      return Response.json({});
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const paths = () => calls.map((c) => new URL(c.url).pathname);

describe("terms gate in the page guard", () => {
  it("shows the gate instead of the page, without loading page data", async () => {
    const load = vi.fn(async () => "data");
    const page = await consolePage(load);
    expect(page.live).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(paths()).toEqual(["/v1/me", "/v1/me/consents"]);
    expect(calls[1]!.auth).toBe("Bearer astro-token");
    if (page.live) return;
    const html = renderToStaticMarkup(page.notice);
    expect(html).toContain("Astrologer terms");
    expect(html).toContain("version 2026-10-21");
    expect(html).toContain('href="http://localhost:3000/terms"');
    // The banned-topic list is on the gate itself.
    expect(html).toContain("No fear selling");
    expect(html).toContain("No contact details or payments outside the platform");
  });

  it("renders the accept checkbox unticked and the button disabled", async () => {
    const html = renderToStaticMarkup(<TermsGatePage version="2026-10-21" />);
    const box = /<input type="checkbox"[^>]*name="agree"[^>]*>/.exec(html)?.[0];
    expect(box).toBeDefined();
    expect(box).not.toContain("checked");
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Accept and continue<\/button>/);
  });

  it("opens the page once the current version is accepted", async () => {
    consentsBody = {
      version: "2026-10-21",
      required: [],
      accepted: [
        { kind: "astrologer_terms", version: "2026-10-21", accepted_at: "2026-10-21T05:00:00Z" },
      ],
      current: true,
    };
    const page = await consolePage(async () => "data");
    expect(page).toEqual({ live: true, data: "data" });
  });

  it("stays open when the consent endpoint fails (the API still enforces writes)", async () => {
    consentsStatus = 503;
    expect(await consolePage(async () => "data")).toEqual({ live: true, data: "data" });
  });

  it("skips the gate for the session room", async () => {
    const page = await consolePage(async () => "room", { terms: false });
    expect(page).toEqual({ live: true, data: "room" });
    expect(paths()).toEqual(["/v1/me"]);
  });
});

describe("safety panel", () => {
  const resources = normalizeResources(helplinesJson);

  it("lists the helplines from the data file with tel: links and calm guidance", () => {
    expect(resources).not.toBeNull();
    const html = renderToStaticMarkup(<SafetyPanel resources={resources} />);
    expect(html).toContain("The client may be in crisis");
    for (const h of resources!.helplines) {
      expect(html).toContain(`href="tel:${h.number}"`);
      expect(html).toContain(h.name.en.replace(/&/g, "&amp;"));
    }
    expect(html).toContain("Do not sell anything");
    expect(html).toContain("can end the session at any time");
    expect(html).not.toMatch(/dismiss/i);
  });

  it("says plainly when the numbers could not be loaded, without inventing any", () => {
    const html = renderToStaticMarkup(<SafetyPanel resources={null} failed />);
    expect(html).toContain("could not be loaded");
    expect(html).not.toMatch(/tel:/);
    expect(renderToStaticMarkup(<SafetyPanel resources={null} />)).toContain("Loading helpline");
  });
});

describe("blocked message notice", () => {
  it("says the message was not sent and why", () => {
    const html = renderToStaticMarkup(<BlockedNotice reason="off_platform_payment" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(
      "Your message was not sent: it asked for a payment outside the platform",
    );
    expect(html).toContain("The client did not see it.");
    expect(html).toContain('href="/conduct"');
  });
});
