FROM node:22-alpine AS base

# Install dependencies only when needed
FROM base AS deps
# Pin pnpm to v10 — v11 makes ignored-build-scripts fatal even when
# `pnpm.onlyBuiltDependencies` is set in package.json, breaking CI install.
RUN apk add --no-cache libc6-compat && npm install -g pnpm@10

WORKDIR /app

# Copy package manifests, build config, and ALL dialect templates so the
# postinstall hook can stamp out a matching schema.ts during install.
COPY package.json pnpm-lock.yaml* vite.config.ts ./
COPY scripts/db-setup.mjs scripts/db-setup.mjs
COPY src/config/db/schema.sqlite.ts src/config/db/schema.sqlite.ts
COPY src/config/db/schema.postgres.ts src/config/db/schema.postgres.ts
COPY src/config/db/schema.mysql.ts src/config/db/schema.mysql.ts

# DATABASE_PROVIDER must be set at build time so prebuild / postinstall pick
# the matching schema template. Pass it via `docker build --build-arg
# DATABASE_PROVIDER=postgresql` or set in your CI / k8s build pipeline.
ARG DATABASE_PROVIDER=sqlite
ENV DATABASE_PROVIDER=${DATABASE_PROVIDER}

RUN pnpm i --frozen-lockfile

# Rebuild the source code only when needed
FROM deps AS builder

WORKDIR /app

# NODE_ENV=production so loadEnvFiles() in vite.config.ts reads .env.production
ENV NODE_ENV=production

# Intranet build args (build-time public values; see vite.config.ts):
# - APP_BASE_PATH=/wiki bakes the /wiki base path into asset URLs, the
#   router basepath and the server-function paths. It must be set HERE —
#   setting it only at runtime does not change the built bundle.
# - VITE_APP_URL / VITE_AAD_LOGIN_ENABLED are public (client-visible) vars.
#   Secrets (AUTH_SECRET, AAD URL) are NEVER build args — runtime env only.
ARG APP_BASE_PATH=
ARG VITE_APP_URL=
ARG VITE_AAD_LOGIN_ENABLED=
ENV APP_BASE_PATH=${APP_BASE_PATH}
ENV VITE_APP_URL=${VITE_APP_URL}
ENV VITE_AAD_LOGIN_ENABLED=${VITE_AAD_LOGIN_ENABLED}

COPY . .
# Pre-compile Paraglide messages BEFORE vite build. On a clean checkout
# src/paraglide does not exist yet and the vite plugin regenerates it during
# the build; message imports can resolve before all per-message files land,
# so Rollup replaces the missing exports with (void 0) — observed in the
# first intranet image as "TypeError: (void 0) is not a function" in SSR
# chunks with no messages chunk in .output. Generating here first makes the
# build deterministic; the plugin still regenerates with its own options
# during `pnpm build`.
RUN ./node_modules/.bin/paraglide-js compile --project ./project.inlang --outdir ./src/paraglide --strategy url cookie baseLocale --output-structure message-modules
RUN pnpm build

# Production image — run the nitro server output
FROM base AS runner
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 appuser && \
    mkdir -p /app/data/blog-html && \
    chown -R appuser:nodejs /app/data

COPY --from=builder --chown=appuser:nodejs /app/.output ./.output

USER appuser

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

CMD ["node", ".output/server/index.mjs"]
