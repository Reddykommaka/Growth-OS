# syntax=docker/dockerfile:1.7
#
# One multi-stage Dockerfile produces all four app images, selected by the APP build arg.
# 12-devops-architecture.md §2: everything ships as an OCI container with no
# platform-proprietary primitive, so the deployment target stays replaceable.

ARG NODE_VERSION=22.22.2
ARG APP=api

# ---------------------------------------------------------------- base
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

# ---------------------------------------------------------------- dependencies
# Manifests only, so a source-only change does not invalidate the install layer.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json           apps/api/
COPY apps/web/package.json           apps/web/
COPY apps/worker/package.json        apps/worker/
COPY apps/link/package.json          apps/link/
COPY packages/ui/package.json        packages/ui/
COPY packages/charts/package.json    packages/charts/
COPY packages/testing/package.json   packages/testing/
COPY packages/platform/              packages/platform/
COPY packages/modules/               packages/modules/
COPY packages/integrations/          packages/integrations/
# Keep only the manifests from the tree copies above.
RUN find packages -type f ! -name package.json -delete && find packages -type d -empty -delete
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------- build
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline
RUN pnpm run build

# Strip development dependencies from what ships.
RUN pnpm prune --prod --ignore-scripts

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP
ENV NODE_ENV=production \
    APP_NAME=${APP} \
    # Node does not see the container memory limit by default and will happily grow past it
    # until the OOM killer intervenes.
    NODE_OPTIONS="--max-old-space-size=384"

# dumb-init reaps zombies and forwards SIGTERM, which PID 1 in Node does not do. Without it
# a rolling deploy severs in-flight requests instead of draining them.
RUN apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Non-root. The node image ships an unprivileged `node` user; use it rather than creating one.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages    ./packages
COPY --from=build --chown=node:node /app/apps        ./apps
COPY --from=build --chown=node:node /app/package.json ./

USER node
EXPOSE 3000

# The orchestrator owns liveness; this is for `docker run` and local compose only.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
# APP is resolved at build time; the runtime command is fixed so the image is immutable.
CMD ["sh", "-c", "exec node apps/${APP_NAME}/dist/index.js"]
