# The exit test of the web client (M6): `make test-m6`, from a clean checkout with Docker and no secret:
#   bun install --frozen-lockfile && make down && make up && make test-m6 && make down && bun run licence
# It installs the browsers if they are missing (and stops with "playwright browsers missing" if it cannot), builds the client in `e2e` mode, runs `check:build`, starts the stack with the
# handshake required (compose.m6.yaml, M6_REQUIRE_HANDSHAKE=1), serves the client on 4173 (another origin than the API on 8080) and runs the scenarios of
# apps/web/test-e2e/m6/scenarios.ts in Chromium, Firefox and WebKit. The scenarios of screens that are not built yet are listed as pending in the run and in docs/proof/m6-exit.md.
# A real sign-in with the identity provider is not part of it. The Makefile does not change for this target: `-include mk/*.mk` takes this file.
M6_BROWSERS := chromium firefox webkit
M6_PLAYWRIGHT := E2E_DEV_TOKEN_SECRET="$$(sed -n 's/^GRIMOIRE_DEV_TOKEN_SECRET=//p' .env)" M6_EXIT=1 M6_REQUIRE_HANDSHAKE=1 bunx playwright test -c apps/web/playwright.config.ts
test-m6: dev-secret
	bun install --frozen-lockfile
	-bunx playwright install --with-deps $(M6_BROWSERS)
	bun run apps/web/test-e2e/support/run-check.ts
	bun run apps/web/test-e2e/m6/scenarios.ts check
	bun run build
	cd apps/web && bunx vite build --mode e2e
	cd apps/web && bun run check:build
	M6_REQUIRE_HANDSHAKE=1 GRIMOIRE_S3_PUBLIC_ENDPOINT=http://127.0.0.1:8333 $(WEB_COMPOSE) $(MAKE) up
	GRIMOIRE_ALLOWED_ORIGINS="http://127.0.0.1:8080,http://localhost:8080,http://127.0.0.1:$${E2E_WEB_PORT:-4173},http://localhost:$${E2E_WEB_PORT:-4173}" $(MAKE) files-setup
	$(M6_PLAYWRIGHT) --project=chromium apps/web/test-e2e/m6/handshake.spec.ts
	$(M6_PLAYWRIGHT) $(foreach browser,$(M6_BROWSERS),--project=$(browser)) $$(bun run apps/web/test-e2e/m6/scenarios.ts files)

.PHONY: test-m6
