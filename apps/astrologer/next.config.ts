import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker images use the standalone server; local `next start` needs the default output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  transpilePackages: ["@astro/shared"],
  poweredByHeader: false,
  // Lets parallel builds of the same checkout use separate output folders.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  agentRules: false,
  // Working console for astrologers: never indexed, never framed, no referrer to other sites.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // Session data and chat must never sit in a shared or browser cache.
        source: "/api/:path*",
        headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }],
      },
    ];
  },
};

export default nextConfig;
