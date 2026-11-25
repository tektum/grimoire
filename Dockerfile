# Grimoire application image: one Node process, one HTTP port (HTTP API and /collab WebSocket).
# Build on node:26-slim, run on distroless (no shell, non-root UID 65532). Digests pin both bases.
# bun is only the package manager of the build stage: it comes from the first stage below (its version is the one in mise.toml, checked by
# layout.test.ts) and is not copied into the image. Node runs the compiler, the tools and the server.

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS bun

# The model files of the semantic search (M7-T12): the only network use of the model path, at build time. Each file is checked against the lock (SHA-256 and size) when it is fetched and again
# after: a build whose file is not the locked one fails here. The server reads them from /app/models and never fetches anything.
# `GRIMOIRE_MODELS=skip` leaves /app/models empty: for the images of the test jobs that run with the semantic search off (about 400 MB less to fetch). The default, and the production image, fetch.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS models
WORKDIR /src
ARG GRIMOIRE_MODELS=fetch
COPY models/models.lock.json scripts/fetch-models.mjs ./
RUN if [ "$GRIMOIRE_MODELS" = skip ]; then mkdir -p /models; else node fetch-models.mjs --lock models.lock.json --out /models && node fetch-models.mjs --lock models.lock.json --out /models --verify && cp models.lock.json /models/models.lock.json; fi

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# Belt and braces with the "trustedDependencies": [] below: the ONNX runtime's install script, which would download 284 MB of proprietary GPU libraries, is neither run nor allowed to.
ENV ONNXRUNTIME_NODE_INSTALL_CUDA=skip
# Amazon's certificate authorities for the managed database (RDS): the connection to it is verified (sslmode=verify-full) against this bundle, which the server finds through
# NODE_EXTRA_CA_CERTS, set by the deployment that uses RDS. Readable by everyone (--chmod=644): ADD writes a fetched file as 0600 and the server runs as 65532, which
# would then load no authorities at all. Fetched with a pinned checksum: when Amazon publishes a new bundle the build fails here until the checksum is updated.
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /rds/global-bundle.pem
COPY . .
# bun runs a dependency's install script only if it is trusted: the root package.json sets "trustedDependencies": [] (which also switches off bun's built-in default list), so no install script runs, as with npm's --ignore-scripts.
RUN bun install --frozen-lockfile
# The root build, in its own order: the server, the OpenAPI document and the client types made from it, then every package (the Markdown adapter with its worker file, and the packages the web client imports).
RUN bun run build
# The web client, built once for every deployment (its imports are built above): its address-dependent files (config.json and the response headers) are made by the server at start from its settings.
RUN bun run --cwd apps/web build
# Production dependencies only: bun does not prune an existing node_modules, so install again from nothing with just the two workspaces
# (and what they depend on); the dist directories built above stay in place and the workspace links are made again.
RUN rm -rf node_modules && bun install --frozen-lockfile --production --filter @tektum/grimoire-server --filter @tektum/grimoire-adapter-markdown-milkdown --filter @tektum/grimoire-adapter-embedder-onnx
# Stage exactly what runs: per workspace package its package.json, dist and any CommonJS entry (`*.cjs`) beside it, the pruned node_modules, the migrations
# directory (@types/debug, mdast, ms and unist are real dependencies of the Markdown libraries, but hold only type declarations; test helpers compiled into dist/testing, the declarations of the test projects in dist/test and build info are left out). A shell is fine here: this stage is not shipped.
RUN set -eu; mkdir /out; cp package.json /out/; mkdir /out/certs; install -m 0644 /rds/global-bundle.pem /out/certs/global-bundle.pem; test "$(stat -c %a /out/certs/global-bundle.pem)" = 644; cp -a node_modules /out/node_modules; \
    for d in apps/server packages/core packages/editor-schema packages/adapters/*; do \
      mkdir -p "/out/$d"; cp "$d/package.json" "/out/$d/"; cp -a "$d/dist" "/out/$d/dist"; cp "$d"/*.cjs "/out/$d/" 2>/dev/null || true; \
    done; \
    mkdir -p /out/db; cp -a db/migrations /out/db/migrations; \
    mkdir -p /out/web; cp -a apps/web/dist /out/web/dist; cp apps/web/headers/headers.template /out/web/headers.template; \
    rm -rf /out/packages/adapters/auth-fake /out/node_modules/@tektum/grimoire-adapter-auth-fake; \
    find /out -path /out/node_modules -prune -o \( -name testing -type d -o -path '*/dist/test' -type d -o -name '*.tsbuildinfo' \) -exec rm -rf {} +; \
    rm -rf /out/node_modules/@types; \
    find /out/node_modules -xtype l -delete # drop links to packages not shipped (web, api-client)

# The ONNX runtime's package holds the native library of every platform (294 MB); the image keeps the one it runs on. The build fails if that one is missing, if what is left is over
# 80 MB, or if anything named for CUDA or TensorRT is in what ships.
RUN set -eu; rt=/out/node_modules/onnxruntime-node/bin/napi-v6; arch="$(node -p process.arch)"; test -d "$rt/linux/$arch"; \
    for d in "$rt"/*; do [ "$(basename "$d")" = linux ] || rm -rf "$d"; done; \
    for d in "$rt"/linux/*; do [ "$(basename "$d")" = "$arch" ] || rm -rf "$d"; done; \
    test -f "$rt/linux/$arch/onnxruntime_binding.node"; \
    test "$(du -sm "$rt" | cut -f1)" -le 80; \
    test -z "$(find /out \( -iname '*cuda*' -o -iname '*tensorrt*' -o -iname 'libnvinfer*' \) -print -quit)"

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:1d736cf8b5716c07a245301f92717143215d248fd55771ee1936ef4b3302e531
ENV NODE_ENV=production GRIMOIRE_HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out/ /app/
# The model files, read from here (GRIMOIRE_SEMANTIC_MODEL_DIR, default /app/models) with the lock they are checked against; world-readable, the process is UID 65532.
COPY --from=models /models /app/models
# The built web client is in /app/web. The server serves it only when GRIMOIRE_WEB_ROOT=/app/web is set, which needs the public API and live editing addresses and the file store.
USER 65532:65532
EXPOSE 8080
# Node is PID 1; the server handles SIGTERM (drains, saves open pages, exits). No image-level healthcheck: the shell-less base has no curl, Compose probes /readyz.
CMD ["apps/server/dist/main.js"]
