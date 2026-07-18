# Playwright 공식 베이스 (Chromium + deps 포함)
FROM mcr.microsoft.com/playwright:v1.52.0-jammy AS base

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app
# 빌드 컨텍스트는 저장소 루트. frozen-lockfile 설치는 전체 워크스페이스의
# package.json이 있어야 하므로 apps/packages를 모두 복사한다(소스 포함, 이미지
# 크기 영향 미미). 브라우저는 베이스 이미지(Chromium v1.52.0)를 그대로 사용.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --filter @youni/worker...
RUN pnpm --filter @youni/worker... build

ENV NODE_ENV=production
CMD ["node", "apps/worker/dist/index.js"]
