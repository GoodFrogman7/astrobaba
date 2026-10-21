import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "../../../packages/shared/analytics/events.json" with { type: "json" };
import { normalizePath, PATH_RE } from "../src/lib/analytics/path";
import { pageViewProperties } from "../src/lib/analytics/pageview";
import {
  beaconTransport,
  EventQueue,
  isValidClientEvent,
  type ClientEvent,
} from "../src/lib/analytics/queue";
import { classifySource, hostMatches, normalizeUtm } from "../src/lib/analytics/source";

const ev = (over: Partial<ClientEvent> = {}): ClientEvent => ({
  event: "page_view",
  ts: "2026-10-21T10:00:00.000Z",
  locale: "en",
  properties: { path: "/kundli" },
  ...over,
});

describe("source classification", () => {
  it("is campaign whenever utm_source is present", () => {
    expect(classifySource("https://www.google.com/", "site.in", "newsletter")).toBe("campaign");
    expect(classifySource("", "site.in", "x")).toBe("campaign");
  });

  it("is direct without a referrer, with a bad one, or from this site", () => {
    expect(classifySource("", "site.in")).toBe("direct");
    expect(classifySource(null, "site.in")).toBe("direct");
    expect(classifySource("not a url", "site.in")).toBe("direct");
    expect(classifySource("android-app://com.google.android.gm/", "site.in")).toBe("direct");
    expect(classifySource("https://site.in/kundli", "site.in")).toBe("direct");
  });

  it("recognises the fixed search engine list", () => {
    for (const r of [
      "https://www.google.com/",
      "https://www.google.co.in/search?q=x",
      "https://google.com",
      "https://www.bing.com/",
      "https://duckduckgo.com/",
      "https://in.search.yahoo.com/",
      "https://yandex.ru/",
      "https://www.ecosia.org/",
    ])
      expect(classifySource(r, "site.in"), r).toBe("search");
  });

  it("recognises the fixed social list", () => {
    for (const r of [
      "https://m.facebook.com/",
      "https://l.instagram.com/",
      "https://t.co/abc",
      "https://x.com/someone",
      "https://mobile.twitter.com/",
      "https://web.whatsapp.com/",
      "https://www.linkedin.com/",
      "https://www.youtube.com/",
      "https://old.reddit.com/",
      "https://in.pinterest.com/",
      "https://web.telegram.org/",
    ])
      expect(classifySource(r, "site.in"), r).toBe("social");
  });

  it("is referral for any other host, without loose matches", () => {
    expect(classifySource("https://example.com/post", "site.in")).toBe("referral");
    // "t.co" and "x.com" are domains, not substrings.
    expect(classifySource("https://notabot.co/", "site.in")).toBe("referral");
    expect(classifySource("https://box.com/", "site.in")).toBe("referral");
    expect(classifySource("https://xt.co/", "site.in")).toBe("referral");
    // "google." is a whole label, not a suffix of another one.
    expect(classifySource("https://mygoogle.example/", "site.in")).toBe("referral");
  });

  it("matches labels and domains as documented", () => {
    expect(hostMatches("www.google.co.in", "google.")).toBe(true);
    expect(hostMatches("t.co", "t.co")).toBe(true);
    expect(hostMatches("a.t.co", "t.co")).toBe(true);
    expect(hostMatches("at.co", "t.co")).toBe(false);
  });
});

describe("utm values", () => {
  it("are lower-cased, limited to [a-z0-9-] and cut to 80 characters", () => {
    expect(normalizeUtm("Newsletter_Oct 2026!")).toBe("newsletter-oct-2026-");
    expect(normalizeUtm("x".repeat(100))).toHaveLength(80);
    expect(normalizeUtm("")).toBeUndefined();
    expect(normalizeUtm(null)).toBeUndefined();
    expect(normalizeUtm("दिवाली")).toBe("------");
  });
});

describe("path normalization", () => {
  it("drops the query string, fragment, trailing slash and the /hi prefix", () => {
    expect(normalizePath("/kundli?name=Asha&dob=1990-01-01")).toBe("/kundli");
    expect(normalizePath("/tools/nakshatra#result")).toBe("/tools/nakshatra");
    expect(normalizePath("/hi/panchang/new-delhi/")).toBe("/panchang/new-delhi");
    expect(normalizePath("/hi")).toBe("/");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/history")).toBe("/history");
  });

  it("replaces UUID segments with _id", () => {
    expect(normalizePath("/chat/3f2b8c1e-9a4d-4c6b-8e2f-1a2b3c4d5e6f")).toBe("/chat/_id");
    expect(normalizePath("/hi/account/reports/3F2B8C1E-9A4D-4C6B-8E2F-1A2B3C4D5E6F/x")).toBe(
      "/account/reports/_id/x",
    );
  });

  it("skips paths the schema would reject", () => {
    expect(normalizePath("/Kundli")).toBeNull();
    expect(normalizePath("/search/%E0%A4%95")).toBeNull();
    expect(normalizePath("/a.b")).toBeNull();
    expect(normalizePath(`/${"a".repeat(200)}`)).toBeNull();
    expect(normalizePath("kundli")).toBeNull();
  });

  it("uses the same pattern as the shared schema (version 2)", () => {
    expect(schema.version).toBe(2);
    const spec = schema.propertyTypes.path;
    expect(PATH_RE.source).toBe(new RegExp(spec.slice(spec.indexOf("^"))).source);
    expect(PATH_RE.source).toBe(/^\/[a-z0-9/_-]{0,199}$/.source);
  });
});

describe("page_view properties", () => {
  const base = { search: "", referrer: "", ownHost: "site.in" };
  it("send source and utm only on the first page view of a tab session", () => {
    const first = pageViewProperties({
      ...base,
      pathname: "/hi/kundli",
      search: "?utm_source=WhatsApp+Group&utm_campaign=Diwali_2026&name=Asha",
      first: true,
    });
    expect(first).toEqual({
      path: "/kundli",
      source: "campaign",
      utm_source: "whatsapp-group",
      utm_campaign: "diwali-2026",
    });
    const later = pageViewProperties({
      ...base,
      pathname: "/tools",
      search: "?utm_source=x",
      first: false,
    });
    expect(later).toEqual({ path: "/tools" });
    const search = pageViewProperties({
      ...base,
      pathname: "/",
      referrer: "https://www.google.com/",
      first: true,
    });
    expect(search).toEqual({ path: "/", source: "search" });
  });

  it("is null for a path that cannot be recorded", () => {
    expect(pageViewProperties({ ...base, pathname: "/Bad", first: true })).toBeNull();
  });
});

describe("client-side validation", () => {
  it("accepts the events the site sends", () => {
    expect(isValidClientEvent(ev())).toBe(true);
    expect(isValidClientEvent(ev({ event: "tool_started", properties: { tool: "kundli" } }))).toBe(
      true,
    );
    expect(
      isValidClientEvent(
        ev({ event: "tool_completed", properties: { tool: "mulank", unknown_birth_time: false } }),
      ),
    ).toBe(true);
    expect(
      isValidClientEvent(
        ev({
          event: "consult_cta_clicked",
          properties: { source: "expert-card", astrologer_slug: "pandit-a" },
        }),
      ),
    ).toBe(true);
    expect(
      isValidClientEvent(ev({ event: "otp_requested", properties: { source: "wallet" } })),
    ).toBe(true);
  });

  it("rejects free text, unknown fields and bad values, so they never leave the browser", () => {
    expect(isValidClientEvent(ev({ properties: { path: "/kundli", name: "Asha" } }))).toBe(false);
    expect(isValidClientEvent(ev({ properties: { path: "/kundli?dob=1990-01-01" } }))).toBe(false);
    expect(
      isValidClientEvent(ev({ event: "otp_requested", properties: { source: "+91 98765 43210" } })),
    ).toBe(false);
    expect(isValidClientEvent(ev({ event: "nope" as never }))).toBe(false);
    expect(isValidClientEvent(ev({ locale: "fr" as never }))).toBe(false);
    expect(isValidClientEvent(ev({ ts: "yesterday" }))).toBe(false);
  });
});

describe("event queue", () => {
  it("queues valid events only and sends them on flush", () => {
    const sent: string[] = [];
    const q = new EventQueue((b) => sent.push(b));
    expect(q.push(ev())).toBe(true);
    expect(q.push(ev({ properties: { path: "/Bad" } }))).toBe(false);
    expect(q.size).toBe(1);
    expect(sent).toHaveLength(0);
    expect(q.flush()).toBe(1);
    expect(JSON.parse(sent[0]!)).toEqual({ events: [ev()] });
    expect(q.flush()).toBe(0);
  });

  it("sends at most 20 events per request", () => {
    const sent: string[] = [];
    const q = new EventQueue((b) => sent.push(b), 20, 1000);
    for (let i = 0; i < 19; i++) q.push(ev());
    expect(sent).toHaveLength(0);
    q.push(ev()); // the 20th fills a batch: sent at once
    expect(sent).toHaveLength(1);
    expect((JSON.parse(sent[0]!) as { events: unknown[] }).events).toHaveLength(20);
    for (let i = 0; i < 5; i++) q.push(ev());
    q.flush();
    expect(sent.map((s) => (JSON.parse(s) as { events: unknown[] }).events.length)).toEqual([
      20, 5,
    ]);
  });

  it("drops the oldest events past its bound", () => {
    const sent: string[] = [];
    const q = new EventQueue((b) => sent.push(b), 50, 45);
    for (let i = 0; i < 49; i++) q.push(ev({ properties: { path: `/p${i}` } }));
    expect(q.size).toBe(45);
    q.flush();
    const paths = (JSON.parse(sent[0]!) as { events: ClientEvent[] }).events.map(
      (e) => e.properties.path,
    );
    expect(paths[0]).toBe("/p4");
    expect(paths).toHaveLength(45);
  });

  it("never throws when the transport fails", () => {
    const q = new EventQueue(() => {
      throw new Error("offline");
    });
    q.push(ev());
    expect(() => q.flush()).not.toThrow();
    expect(q.size).toBe(0);
  });
});

describe("beacon transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses navigator.sendBeacon", () => {
    const beacon = vi.fn(() => true);
    const fetchMock = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    vi.stubGlobal("fetch", fetchMock);
    beaconTransport("/api/e")('{"events":[]}');
    expect(beacon).toHaveBeenCalledWith("/api/e", '{"events":[]}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to fetch with keepalive when the beacon is refused or missing", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("navigator", { sendBeacon: () => false });
    beaconTransport("/api/e")("a");
    vi.stubGlobal("navigator", {});
    beaconTransport("/api/e")("b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual([
      "/api/e",
      expect.objectContaining({ method: "POST", body: "a", keepalive: true }),
    ]);
  });
});

describe("browser client", () => {
  type Listener = () => void;
  let docListeners: Record<string, Listener[]>;
  let sent: string[];
  let cookie: string;
  let visibility: string;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    docListeners = {};
    sent = [];
    cookie = "";
    visibility = "visible";
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
      addEventListener: () => undefined,
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      },
    });
    vi.stubGlobal("document", {
      get cookie() {
        return cookie;
      },
      get visibilityState() {
        return visibility;
      },
      documentElement: { lang: "hi" },
      addEventListener: (type: string, fn: Listener) => {
        (docListeners[type] ??= []).push(fn);
      },
    });
    vi.stubGlobal("navigator", {
      sendBeacon: (_url: string, body: string) => {
        sent.push(body);
        return true;
      },
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const batches = () => sent.map((s) => (JSON.parse(s) as { events: ClientEvent[] }).events);

  it("flushes every 5 seconds with the page's locale", async () => {
    const { track } = await import("../src/lib/analytics/client");
    expect(track("tool_started", { tool: "kundli" })).toBe(true);
    vi.advanceTimersByTime(4999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(batches()).toEqual([
      [
        expect.objectContaining({
          event: "tool_started",
          locale: "hi",
          properties: { tool: "kundli" },
        }),
      ],
    ]);
  });

  it("flushes when the tab is hidden", async () => {
    const { track } = await import("../src/lib/analytics/client");
    track("page_view", { path: "/" });
    visibility = "hidden";
    for (const fn of docListeners.visibilitychange ?? []) fn();
    expect(batches()).toHaveLength(1);
  });

  it("sends nothing after the privacy switch, with GPC or with DNT", async () => {
    const { track } = await import("../src/lib/analytics/client");
    cookie = "x=1; aid_off=1";
    expect(track("page_view", { path: "/" })).toBe(false);
    cookie = "";
    vi.stubGlobal("navigator", { globalPrivacyControl: true, sendBeacon: () => true });
    expect(track("page_view", { path: "/" })).toBe(false);
    vi.stubGlobal("navigator", { doNotTrack: "1", sendBeacon: () => true });
    expect(track("page_view", { path: "/" })).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(sent).toHaveLength(0);
  });

  it("reports the first page view of a tab session once", async () => {
    const { takeFirstPageView } = await import("../src/lib/analytics/client");
    expect(takeFirstPageView()).toBe(true);
    expect(takeFirstPageView()).toBe(false);
  });
});
