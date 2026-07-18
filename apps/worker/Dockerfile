# Playwright 공식 베이스 (Chromium + deps 포함)
FROM mcr.microsoft.com/playwright:v1.52.0-jammy AS base

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN pnpm install --frozen-lockfile --filter @youni/worker...
RUN pnpm --filter @youni/worker... build

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]
