# Build from the repo root: docker build -f apps/astrologer/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/astrologer/package.json apps/astrologer/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @astro/astrologer...
COPY packages/shared packages/shared
COPY apps/astrologer apps/astrologer
ENV NEXT_OUTPUT=standalone NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @astro/astrologer build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3002 HOSTNAME=0.0.0.0
COPY --from=build /repo/apps/astrologer/.next/standalone ./
COPY --from=build /repo/apps/astrologer/.next/static ./apps/astrologer/.next/static
USER node
EXPOSE 3002
CMD ["node", "apps/astrologer/server.js"]
