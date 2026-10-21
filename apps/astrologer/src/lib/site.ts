/** The public site, for links to the application status page. */
export function publicSiteUrl(): string {
  return (
    process.env.PUBLIC_SITE_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

export function applicationStatusUrl(): string {
  return `${publicSiteUrl()}/astrologers/apply/status`;
}
