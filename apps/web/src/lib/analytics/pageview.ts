import { normalizePath } from "./path";
import { classifySource, normalizeUtm } from "./source";

export interface PageViewInput {
  pathname: string;
  search: string;
  referrer: string;
  ownHost: string;
  /** First page view of this browser tab session: only then source and utm_* are sent. */
  first: boolean;
}

/** page_view properties, or null when the path cannot be recorded (docs/api/growth.md §1.1). */
export function pageViewProperties(input: PageViewInput): Record<string, string> | null {
  const path = normalizePath(input.pathname);
  if (!path) return null;
  const props: Record<string, string> = { path };
  if (!input.first) return props;
  const params = new URLSearchParams(input.search);
  const utmSource = normalizeUtm(params.get("utm_source"));
  const utmCampaign = normalizeUtm(params.get("utm_campaign"));
  props.source = classifySource(input.referrer, input.ownHost, utmSource);
  if (utmSource) props.utm_source = utmSource;
  if (utmCampaign) props.utm_campaign = utmCampaign;
  return props;
}
