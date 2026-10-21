"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { analyticsDisabled, takeFirstPageView, track } from "@/lib/analytics/client";
import { normalizePath } from "@/lib/analytics/path";
import { pageViewProperties } from "@/lib/analytics/pageview";

const SLUG = /^[a-z0-9-]{1,80}$/;

/**
 * Mounted once in the locale layout. Records page_view on every App Router navigation (source
 * and utm_* only on the first page view of a tab session) and consult_cta_clicked for any
 * element marked `data-consult-cta="<source>"` (with an optional `data-astrologer-slug`).
 * Renders nothing.
 */
export function Analytics() {
  const pathname = usePathname();
  const last = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname || pathname === last.current) return;
    last.current = pathname;
    if (analyticsDisabled() || !normalizePath(pathname)) return;
    const props = pageViewProperties({
      pathname,
      search: window.location.search,
      referrer: document.referrer,
      ownHost: window.location.hostname,
      first: takeFirstPageView(),
    });
    if (props) track("page_view", props);
  }, [pathname]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const el = (e.target as Element | null)?.closest?.("[data-consult-cta]");
      if (!el) return;
      const source = el.getAttribute("data-consult-cta") ?? "";
      const slug = el.getAttribute("data-astrologer-slug") ?? "";
      if (!SLUG.test(source)) return;
      track(
        "consult_cta_clicked",
        SLUG.test(slug) ? { source, astrologer_slug: slug } : { source },
      );
    }
    document.addEventListener("click", onClick, { capture: true });
    return () => document.removeEventListener("click", onClick, { capture: true });
  }, []);

  return null;
}
