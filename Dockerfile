# syntax=docker/dockerfile:1.7
#
# Casual Slides — single image: web bundle + /collab WebSocket relay.
#
#   docker build -t casualoffice/casual-slides:latest .
#   docker run -p 3000:3000 casualoffice/casual-slides:latest
#   open http://localhost:3000
#
# For docker-compose (sets sensible env defaults + restart policy):
#   docker compose up
#
# Multi-stage layout:
#   deps         — installs the workspace's full dep graph once
#   build-web    — produces apps/web/dist (served statically by the server)
#   runtime      — node:22-alpine + tsx + only what the server needs
#
# Pinned Node 22-alpine for a small base; pnpm version pulled from
# package.json's `packageManager` field so it matches the workspace.

ARG NODE_VERSION=22-alpine

# ─────────────── deps ───────────────
FROM node:${NODE_VERSION} AS deps
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /repo

# Lockfile + manifests first so Docker caches the dep install across
# source-only changes. patches/ is required for pnpm install because the
# repo's `patchedDependencies` config references files under it.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches patches
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ─────────────── build-web ───────────────
FROM deps AS build-web
COPY apps/web apps/web

# Build-time knobs baked into the Vite bundle. Override at `docker build`
# time via `--build-arg` (see docker-compose.yml `args:` block for the
# canonical defaults). `VITE_COLLAB_ENABLED=true` opens the collab gate
# this image was designed around — flip to `false` for a static-only deploy.
ARG VITE_COLLAB_ENABLED=true
ENV VITE_COLLAB_ENABLED=${VITE_COLLAB_ENABLED}

RUN pnpm --filter @point/web build

# ─────────────── runtime ───────────────
FROM node:${NODE_VERSION} AS runtime
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# wget powers the HEALTHCHECK below. Alpine ships it via busybox.
RUN apk add --no-cache wget

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    STATIC_DIR=/app/apps/web/dist

WORKDIR /app

# Lockfile + manifests + workspace config — required for `pnpm install
# --prod` to resolve the workspace graph cleanly.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches patches
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/

# Prod-only install. tsx lives in the server's dependencies so the
# server can run TypeScript directly without a JS compile step.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod

# Server source (small, tsx executes it directly) + the built web bundle.
COPY apps/server/src apps/server/src
COPY apps/server/tsconfig.json apps/server/
COPY --from=build-web /repo/apps/web/dist apps/web/dist

# ─────────────── OCI image labels ───────────────
ARG CASUAL_VERSION=dev
ARG CASUAL_GIT_SHA=unknown
ARG CASUAL_BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Casual Slides" \
      org.opencontainers.image.description="PowerPoint-flavored web slides editor with .pptx round-trip and optional real-time co-edit. Single image: web app + /collab WebSocket relay on one port. Built on Univer OSS." \
      org.opencontainers.image.url="https://slide.schnsrw.live/" \
      org.opencontainers.image.source="https://github.com/CasualOffice/slides" \
      org.opencontainers.image.documentation="https://schnsrw.live/casual-slides/" \
      org.opencontainers.image.vendor="Sachin Sarwa" \
      org.opencontainers.image.authors="Sachin Sarwa <schnsrw@gmail.com>" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${CASUAL_VERSION}" \
      org.opencontainers.image.revision="${CASUAL_GIT_SHA}" \
      org.opencontainers.image.created="${CASUAL_BUILD_DATE}"

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:3000/health || exit 1

# Drop privileges. node:alpine ships a `node` user.
USER node

WORKDIR /app/apps/server
CMD ["node", "--import", "tsx", "src/index.ts"]
