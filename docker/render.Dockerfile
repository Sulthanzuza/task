# syntax=docker/dockerfile:1

# One image, one process, for Render's free web service (render.yaml).
#
# The Docker deployment runs nginx, the API and the worker as three
# containers. Render's free tier gives one process with 512 MB, so this image
# runs the API with RUN_MODE=all: the HTTP server, Socket.IO, the pg-boss
# worker, and the built web app served by Express, all on one origin.
#
# No BuildKit cache mounts here, unlike docker/api.Dockerfile: they buy
# nothing on a builder that starts cold every time.
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# ---- dependencies -----------------------------------------------------------
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

# ---- build ------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter @tm/web build && pnpm --filter @tm/api build

# ---- runtime ----------------------------------------------------------------
FROM base AS runtime

# argon2 is a native module; it needs its runtime library, not its build tools.
RUN apk add --no-cache libstdc++

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @tm/api... && pnpm store prune

COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/web/dist web

# The defaults this image exists for. Render's own environment still wins, so
# render.yaml can change any of them without a rebuild.
#
# 384 MB of heap inside a 512 MB instance leaves room for what is not heap:
# argon2's 19 MiB per sign-in, socket buffers, and Node itself. Without a
# ceiling V8 sizes its heap from the machine, not the container, and the
# instance is killed for memory before the garbage collector thinks it must run.
ENV NODE_ENV=production \
    RUN_MODE=all \
    WEB_DIST_DIR=/app/web \
    NODE_OPTIONS=--max-old-space-size=384

# Runs unprivileged: a compromise in the process should not own the filesystem.
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

WORKDIR /app/apps/api

# Migrations first, then the server. On a paid instance this would be Render's
# pre-deploy command; the free tier has none, so the start command does it,
# and a failed migration stops the deploy before anything serves. They are
# idempotent, so a restart that runs them again finds nothing to do.
CMD ["sh", "-c", "node dist/db/migrate.js && exec node dist/server.js"]
