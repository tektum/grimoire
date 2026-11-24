# Grimoire application image: one Node process, one HTTP port (HTTP API and /collab WebSocket).
# Build on node:26-slim, run on distroless (no shell, non-root UID 65532). Digests pin both bases.
# bun is only the package manager of the build stage: it comes from the first stage below (its version is the one in mise.toml, checked by
# layout.test.ts) and is not copied into the image. Node runs the compiler, the tools and the server.

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# Amazon's certificate authorities for the managed database (RDS): the connection to it is verified (sslmode=verify-full) against this bundle, which the server finds through
# NODE_EXTRA_CA_CERTS, set by the deployment that uses RDS. Fetched with a pinned checksum: when Amazon publishes a new bundle the build fails here until the checksum is updated.
ADD --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds/global-bundle.pem
COPY . .
# bun runs a dependency's install script only if it is trusted: the root package.json sets "trustedDependencies": [] (which also switches off bun's built-in default list), so no install script runs, as with npm's --ignore-scripts.
RUN bun install --frozen-lockfile
# The root build, in its own order: the server, the OpenAPI document and the client types made from it, then every package (the Markdown adapter with its worker file, and the packages the web client imports).
RUN bun run build
# The web client, built once for every deployment (its imports are built above): its address-dependent files (config.json and the response headers) are made by the server at start from its settings.
RUN bun run --cwd apps/web build
# Production dependencies only: bun does not prune an existing node_modules, so install again from nothing with just the two workspaces
# (and what they depend on); the dist directories built above stay in place and the workspace links are made again.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --filter @tektum/grimoire-server --filter @tektum/grimoire-adapter-markdown-milkdown
# Stage exactly what runs: per workspace package its package.json, dist and any CommonJS entry (`*.cjs`) beside it, the pruned node_modules, the migrations
# directory (@types/debug, mdast, ms and unist are real dependencies of the Markdown libraries, but hold only type declarations; test helpers compiled into dist/testing, the declarations of the test projects in dist/test and build info are left out). A shell is fine here: this stage is not shipped.
RUN set -eu; mkdir /out; cp package.json /out/; mkdir /out/certs; cp /rds/global-bundle.pem /out/certs/; cp -a node_modules /out/node_modules; \
    for d in apps/server packages/core packages/editor-schema packages/adapters/*; do \
      mkdir -p "/out/$d"; cp "$d/package.json" "/out/$d/"; cp -a "$d/dist" "/out/$d/dist"; cp "$d"/*.cjs "/out/$d/" 2>/dev/null || true; \
    done; \
    mkdir -p /out/db; cp -a db/migrations /out/db/migrations; \
    mkdir -p /out/web; cp -a apps/web/dist /out/web/dist; cp apps/web/headers/headers.template /out/web/headers.template; \
    rm -rf /out/packages/adapters/auth-fake /out/node_modules/@tektum/grimoire-adapter-auth-fake; \
    find /out -path /out/node_modules -prune -o \( -name testing -type d -o -path '*/dist/test' -type d -o -name '*.tsbuildinfo' \) -exec rm -rf {} +; \
    rm -rf /out/node_modules/@types; \
    find /out/node_modules -xtype l -delete # drop links to packages not shipped (web, api-client)

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531
ENV NODE_ENV=production GRIMOIRE_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out/ /app/
# The built web client is in /app/web. The server serves it only when GRIMOIRE_WEB_ROOT=/app/web is set, which needs the public API and live editing addresses and the file store.
USER 65532:65532
EXPOSE 8080
# Node is PID 1; the server handles SIGTERM (drains, saves open pages, exits). No image-level healthcheck: the shell-less base has no curl, Compose probes /readyz.
CMD ["apps/server/dist/main.js"]
