import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/**
 * Browser features this site may use. The microphone is allowed for our own pages only (voice
 * calls, docs/api/portal.md §1); everything else stays off, including in embedded frames.
 * No Content-Security-Policy yet: the LiveKit URL arrives at runtime with the call token, so a
 * CSP would need `connect-src` for that wss origin.
 */
const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=(self)",
  "geolocation=()",
  "display-capture=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "midi=()",
].join(", ");

/**
 * Only the production site may be indexed (docs/api/growth.md §3). NEXT_PUBLIC_SITE_ENV is read
 * at build time, like the robots.txt route: set it when building the production image.
 */
const NOINDEX = process.env.NEXT_PUBLIC_SITE_ENV !== "production";

const nextConfig: NextConfig = {
  // Docker images use the standalone server; local `next start` needs the default output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  transpilePackages: ["@astro/shared"],
  poweredByHeader: false,
  // Lets parallel builds of the same checkout use separate output folders.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  agentRules: false,
  // /learn articles are read from src/content/*/learn at request time (sitemap); ship them.
  outputFileTracingIncludes: { "/**/*": ["./src/content/*/learn/*.json"] },
  async rewrites() {
    // IndexNow key file /{INDEXNOW_KEY}.txt; the handler answers 404 unless it is the key.
    return [{ source: "/:key([A-Za-z0-9-]{8,128}).txt", destination: "/api/indexnow-key/:key" }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          ...(NOINDEX ? [{ key: "X-Robots-Tag", value: "noindex" }] : []),
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
