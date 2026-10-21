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

const nextConfig: NextConfig = {
  // Docker images use the standalone server; local `next start` needs the default output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  transpilePackages: ["@astro/shared"],
  poweredByHeader: false,
  // Lets parallel builds of the same checkout use separate output folders.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  agentRules: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Permissions-Policy", value: PERMISSIONS_POLICY },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
