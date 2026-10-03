# syntax=docker/dockerfile:1

# Builds the single-page app, then serves it from Nginx.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @tm/web build

FROM nginx:1.27-alpine AS runtime

# openssl for the placeholder certificate; see entrypoint.d.
RUN apk add --no-cache openssl

# A template rather than a finished config: the certificate paths carry the
# domain, which the image cannot know. nginx's own entrypoint runs envsubst
# over /etc/nginx/templates and writes the result into conf.d.
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/entrypoint.d/ /docker-entrypoint.d/
RUN chmod +x /docker-entrypoint.d/*.sh

COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80 443
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
