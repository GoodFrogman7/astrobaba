import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Docker images use the standalone server; local `next start` needs the default output.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  transpilePackages: ["@astro/shared"],
  poweredByHeader: false,
  // Lets parallel builds of the same checkout use separate output folders.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  agentRules: false,
};

export default withNextIntl(nextConfig);
