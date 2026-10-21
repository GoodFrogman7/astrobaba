# Build from the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @astro/web...
COPY packages/shared packages/shared
# Static Jyotish tables and the panchang city list are bundled into the build.
COPY data/astro data/astro
COPY data/seo data/seo
COPY data/marketplace data/marketplace
# Policy registry and verified helplines, read directly when the API is unreachable.
COPY data/legal data/legal
COPY data/safety data/safety
COPY apps/web apps/web
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
# Read at build time (docs/api/growth.md §3): only NEXT_PUBLIC_SITE_ENV=production is indexable;
# the verification values become <meta> tags. Pass them with --build-arg.
ARG NEXT_PUBLIC_SITE_URL="http://localhost:3000"
ARG NEXT_PUBLIC_SITE_ENV=""
ARG GOOGLE_SITE_VERIFICATION=""
ARG BING_SITE_VERIFICATION=""
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_PUBLIC_SITE_ENV=$NEXT_PUBLIC_SITE_ENV \
    GOOGLE_SITE_VERIFICATION=$GOOGLE_SITE_VERIFICATION \
    BING_SITE_VERIFICATION=$BING_SITE_VERIFICATION
RUN pnpm --filter @astro/web build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
