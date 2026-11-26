# The exit test of the web client (M6): `make test-m6`, from a clean checkout with Docker and no secret:
#   bun install --frozen-lockfile && make down && make up && make test-m6 && make down && bun run licence
# It installs the browsers if they are missing (and stops with "playwright browsers missing" if it cannot), builds the client for production and runs `check:build` on that build (an `e2e`
# build has the development sign-in, which `check:build` refuses), builds it in `e2e` mode, starts the stack with the
# handshake required (compose.m6.yaml, M6_REQUIRE_HANDSHAKE=1), renders the response headers for that stack and serves the client on 4173 with them (another origin than the API
# on 8080), and runs the scenarios of
# apps/web/test-e2e/m6/scenarios.ts in Chromium, Firefox and WebKit. The scenarios of screens that are not built yet are listed as pending in the run and in docs/proof/m6-exit.md.
# A real sign-in with the identity provider is not part of it. The Makefile does not change for this target: `-include mk/*.mk` takes this file.
M6_BROWSERS := chromium firefox webkit
M6_HEADERS := $(CURDIR)/test-results/m6-headers
M6_PLAYWRIGHT := GRIMOIRE_WEB_HEADERS_DIR="$(M6_HEADERS)" E2E_DEV_TOKEN_SECRET="$$(sed -n 's/^GRIMOIRE_DEV_TOKEN_SECRET=//p' .env)" M6_EXIT=1 M6_REQUIRE_HANDSHAKE=1 bunx playwright test -c apps/web/playwright.config.ts
test-m6: dev-secret
	bun install --frozen-lockfile
	-bunx playwright install --with-deps $(M6_BROWSERS)
	bun run apps/web/test-e2e/support/run-check.ts
	bun run apps/web/test-e2e/m6/scenarios.ts check
	bun run build
	cd apps/web && bunx vite build && bun run check:build
	cd apps/web && bunx vite build --mode e2e
	M6_REQUIRE_HANDSHAKE=1 GRIMOIRE_S3_PUBLIC_ENDPOINT=http://127.0.0.1:8333 $(WEB_COMPOSE) $(MAKE) up
	GRIMOIRE_ALLOWED_ORIGINS="http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:$${E2E_WEB_PORT:-4173},http://localhost:$${E2E_WEB_PORT:-4173}" $(MAKE) files-setup
	bun run apps/web/test-e2e/m6/headers.ts
	$(M6_PLAYWRIGHT) --project=chromium apps/web/test-e2e/m6/handshake.spec.ts
	$(M6_PLAYWRIGHT) $(foreach browser,$(M6_BROWSERS),--project=$(browser)) $$(bun run apps/web/test-e2e/m6/scenarios.ts files)

.PHONY: test-m6

# The parts of the exit test that the merge gate runs on every pull request (docs/proof/m6-exit.md says where); the whole of it, in three browsers, runs nightly (the Extended workflow).
# `test-m6-static` needs the workspace built first (`bun run build`): the list of scenarios against the report (a scenario still pending fails it: M6_ALLOW_PENDING=1 allows it while a screen is
# built), and `check:build` on a production build of the client (an `e2e` build has the development sign-in, which it refuses).
.PHONY: test-m6-static
test-m6-static:
	bun run apps/web/test-e2e/m6/scenarios.ts check
	cd apps/web && bunx vite build && bun run check:build

# `test-m6-handshake` is the stack that requires the handshake, with the production response headers served on 4173, and two specs in Chromium: the handshake check, and the one that asserts the page served with its rendered headers (origins.spec.ts skips itself without GRIMOIRE_WEB_HEADERS_DIR, which only this run and `test-m6` set): it starts the stack again with the
# setting changed (the browser jobs run on the stack of the default), and needs the client built in e2e mode, as `make test-web-e2e` leaves it.
.PHONY: test-m6-handshake
test-m6-handshake: dev-secret
	M6_REQUIRE_HANDSHAKE=1 GRIMOIRE_S3_PUBLIC_ENDPOINT=http://127.0.0.1:8333 $(WEB_COMPOSE) $(MAKE) up
	GRIMOIRE_ALLOWED_ORIGINS="http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:$${E2E_WEB_PORT:-4173},http://localhost:$${E2E_WEB_PORT:-4173}" $(MAKE) files-setup
	bun run apps/web/test-e2e/m6/headers.ts
	$(M6_PLAYWRIGHT) --project=chromium apps/web/test-e2e/m6/handshake.spec.ts apps/web/test-e2e/m6/origins.spec.ts
