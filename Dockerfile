# Grimoire application image: one Node process, one HTTP port (HTTP API and /collab WebSocket).
# Build on node:26-slim, run on distroless (no shell, non-root UID 65532). Digests pin both bases.
# bun is only the package manager of the build stage: it comes from the first stage below (its version is the one in mise.toml, checked by
# layout.test.ts) and is not copied into the image. Node runs the compiler, the tools and the server.

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
# bun runs a dependency's install script only if it is trusted: the root package.json sets "trustedDependencies": [] (which also switches off bun's built-in default list), so no install script runs, as with npm's --ignore-scripts.
RUN bun install --frozen-lockfile
# Only the server and the Markdown adapter (which the server loads, with its worker file) plus what they reference; no test projects.
RUN bun run tsc -b apps/server packages/adapters/markdown-milkdown
# Production dependencies only: bun does not prune an existing node_modules, so install again from nothing with just the two workspaces
# (and what they depend on); the dist directories built above stay in place and the workspace links are made again.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --filter @tektum/grimoire-server --filter @tektum/grimoire-adapter-markdown-milkdown
# Stage exactly what runs: per workspace package its package.json and dist, the pruned node_modules, the migrations
# directory (@types/debug, mdast, ms and unist are real dependencies of the Markdown libraries, but hold only type declarations; test helpers compiled into dist/testing and build info are left out). A shell is fine here: this stage is not shipped.
RUN set -eu; mkdir /out; cp package.json /out/; cp -a node_modules /out/node_modules; \
    for d in apps/server packages/core packages/editor-schema packages/adapters/*; do \
      mkdir -p "/out/$d"; cp "$d/package.json" "/out/$d/"; cp -a "$d/dist" "/out/$d/dist"; \
    done; \
    mkdir -p /out/db; cp -a db/migrations /out/db/migrations; \
    rm -rf /out/packages/adapters/auth-fake /out/node_modules/@tektum/grimoire-adapter-auth-fake; \
    find /out -path /out/node_modules -prune -o \( -name testing -type d -o -name '*.tsbuildinfo' \) -exec rm -rf {} +; \
    rm -rf /out/node_modules/@types; \
    find /out/node_modules -xtype l -delete # drop links to packages not shipped (web, api-client)

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531
ENV NODE_ENV=production GRIMOIRE_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out/ /app/
# WEB CLIENT PLACEHOLDER: a later milestone adds the built static files of apps/web here (COPY --from=<web build stage>).
USER 65532:65532
EXPOSE 8080
# Node is PID 1; the server handles SIGTERM (drains, saves open pages, exits). No image-level healthcheck: the shell-less base has no curl, Compose probes /readyz.
CMD ["apps/server/dist/main.js"]
