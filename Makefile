# COMPOSE_FILE (for example compose.yaml:compose.offline.yaml) is honoured; the project name is fixed.
COMPOSE := docker compose -p grimoire

.PHONY: db-up db-down up down down-volumes reset migrate check-compose test-web-e2e test test-m1 test-m1-office test-m1-mutation test-m2 test-m2-hostile-mutation test-m3 test-m3-mutation test-m3-live test-m4

# Compose reads .env for the development passwords and keys; .env.example is the single place they are written down.
# Hand-written: Compose has no "copy a default env file" feature.
.env:
	cp .env.example .env
	chmod 600 .env

# Development tokens carry a per-checkout secret (GRIMOIRE_DEV_TOKEN_SECRET): generated on first use, never a fixed default, kept in the ignored .env
# (mode 600). 32 bytes from the kernel's CSPRNG (/dev/urandom), hex encoded (64 characters). An existing value is never rewritten.
# Every target that starts the app or reads its environment depends on this one (compose-settings.test.ts checks `up` reaches it).
.PHONY: dev-secret pull-images
dev-secret: .env
	@chmod 600 .env
	@grep -q '^GRIMOIRE_DEV_TOKEN_SECRET=.' .env || { [ -z "$$(tail -c1 .env)" ] || echo >> .env; echo "GRIMOIRE_DEV_TOKEN_SECRET=$$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env; echo "generated GRIMOIRE_DEV_TOKEN_SECRET in .env"; }

# Images that are not on this machine yet are pulled first, each with a bounded retry (tools/ci/pull-images.sh): a registry that times out is told apart from a
# product failure, and the start itself then finds the images present.
pull-images:
	@sh tools/ci/pull-images.sh

# NOTE: database initialisation scripts (db/init) run only on an EMPTY volume. A database volume created before
# the roles or passwords changed must be reset with `make reset` (or `make down-volumes`, which deletes the data) before the next `make up` or `make db-up`.
db-up: .env dev-secret
	@sh tools/ci/pull-images.sh --no-bases postgres seaweedfs
	$(COMPOSE) up -d --wait --wait-timeout 120 postgres seaweedfs


# Builds the image, starts PostgreSQL, the file store and the app (waits for healthy), then applies migrations
# and checks /readyz from inside the container (the image has no curl; this also works with the offline override).
up: .env dev-secret pull-images
	$(COMPOSE) up -d --build --wait --wait-timeout 180
	$(MAKE) migrate
	$(COMPOSE) exec -T app /nodejs/bin/node -e "fetch('http://127.0.0.1:8080/readyz').then((r) => r.text().then((t) => { console.log(t); process.exit(r.ok ? 0 : 1); }))"

# Stops and removes the containers and the network; the data volumes stay, so `make up` brings the same data back.
down:
	$(COMPOSE) --profile tools down --remove-orphans

db-down: down

# The only targets that delete data (database and file store volumes).
down-volumes:
	$(COMPOSE) --profile tools down -v --remove-orphans

reset: down-volumes up

# Every setting the loader knows is passed to the app container or listed as deliberately not passed (no stack needed).
check-compose:
	bun run vitest run --project unit apps/server/test/server/compose-settings.test.ts
	$(COMPOSE) config --quiet
	$(COMPOSE) -f compose.yaml -f compose.m3.yaml config --quiet

migrate: .env dev-secret
	$(COMPOSE) --profile tools run --rm --build migrate

test:
	bun run test

# The collaboration end-to-end test: needs `make up`. Ten scenarios, each in its own process, against the running stack; results in test-results/m1/.
# NOTE: the scenarios kill, restart and stop the app container and revoke and grant UPDATE on pages for the runtime role.
test-m1: dev-secret
	bun install --frozen-lockfile
	bun run build
	bun run tsc -b
	rm -f test-results/m1/*.json
	node apps/server/test-e2e/run.ts

# The office scenario: 100 users, 3 pages each, 300 clients on 30 pages.
test-m1-office: dev-secret
	E2E_RESULTS_DIR=test-results/m1-office node apps/server/test-e2e/scenarios/office.ts

# Each limit raised in the app must make its scenario fail; then the app is recreated with the default limits.
test-m1-mutation: dev-secret
	node apps/server/test-e2e/mutation.ts

# The Markdown end-to-end test: needs `make up`. Five scenarios, each in its own process, against the running stack; results in test-results/m2/.
# NOTE: markdown-equals-live recreates the app container with the debug log level (collab.save_skipped is a debug line) and back; restart-mid-edit kills and starts it.
# The mutation proof of the hostile-neighbour scenario: the same scenario with the per-page conversion breaker disabled (a test-only switch the server
# refuses outside local mode) must FAIL because ordinary pages go stale: two hostile pages, each held to one conversion at a time, still hold both workers when nothing cuts them off.
# The scenario checks first that each hostile page kept failing conversions and that no breaker opened, so reaching the staleness check proves the cause. Prints the expected
# FAIL line; exits 0 only if that failure occurred. Needs `make up`.
test-m2-hostile-mutation: dev-secret
	@mkdir -p test-results/m2
	@HOSTILE_NEIGHBOUR_NO_BREAKER=1 E2E_RESULTS_DIR=test-results/m2-mutation node apps/server/test-e2e/m2/run.ts hostile-neighbour > test-results/m2/hostile-mutation.log 2>&1; code=$$?; cat test-results/m2/hostile-mutation.log; \
	if [ $$code -ne 0 ] && grep -q '^FAIL hostile-neighbour: no ordinary page.s stored Markdown was ever more than .* behind its typing' test-results/m2/hostile-mutation.log; then echo "EXPECTED FAIL: hostile-neighbour fails without the breaker (ordinary pages went stale)"; \
	else echo "UNEXPECTED: the scenario did not fail for the right reason with the breaker disabled (exit $$code)"; exit 1; fi

test-m2: dev-secret
	bun install --frozen-lockfile
	bun run build
	bun run tsc -b
	node --test apps/server/test-e2e/m2/known-limit.test.mjs apps/server/test-e2e/m2/own-paragraph.test.mjs
	rm -f test-results/m2/*.json
	node apps/server/test-e2e/m2/run.ts

# The sign-in end-to-end test: starts the app OUTSIDE local mode (real Descope adapter, compose.m3.yaml) against the local key server of tools/m3-keyserver, then runs the
# scenarios one after another against it; results in test-results/m3/. Needs a running stack (`make up` or `make reset`); recreates the app (and starts the key server).
# Afterwards `make up` returns the app to local mode (and `make down-volumes` removes the key server with everything else).
M3_COMPOSE := COMPOSE_FILE=compose.yaml:compose.m3.yaml
test-m3: dev-secret
	bun install --frozen-lockfile
	bun run build
	bun run tsc -b
	sh tools/m3-keyserver/pki.sh test-results/m3/pki
	$(M3_COMPOSE) $(MAKE) up
	rm -f test-results/m3/*.json
	$(M3_COMPOSE) node apps/server/test-e2e/m3/run.ts

# The mutation proofs of the sign-in end-to-end test: each protection is broken on purpose from outside the code (a setting of the recreated app, or a database row a scenario
# sets at its marked place) and its scenario must FAIL with exactly the expected line; exits 0 only if every mutation was detected. Same stack as test-m3; recreates the app per setting.
test-m3-mutation: dev-secret
	bun install --frozen-lockfile
	bun run build
	bun run tsc -b
	sh tools/m3-keyserver/pki.sh test-results/m3/pki
	$(M3_COMPOSE) $(MAKE) up
	rm -f test-results/m3-mutation/*.json
	$(M3_COMPOSE) node apps/server/test-e2e/m3/mutation.ts

# OPT-IN live sign-in check against a real provider project: never run in CI, never on a pull request. Reads its configuration from .env.m3 (git-ignored):
# DESCOPE_DEV_PROJECT_ID, DESCOPE_DEV_TEST_LOGIN, DESCOPE_DEV_MANAGEMENT_KEY. Exits 2 without the file or under CI. Its offline guards: tools/m3-live/test/.
test-m3-live:
	@if [ -n "$$CI" ]; then echo "test-m3-live: refused, CI is set (the live check never runs in CI)" >&2; exit 2; fi
	@if [ ! -f .env.m3 ]; then echo "test-m3-live: .env.m3 is missing" >&2; exit 2; fi
	@set -a; . ./.env.m3; set +a; node tools/m3-live/check.mjs

# The milestone 4 exit test: the whole of milestone 4 against the Compose app in local mode with development tokens (alice administrator, bob member, carol viewer).
# It checks the generated API surface and the compile time, runs the unit tests and the conformance tests, checks the source rules of the scenarios, then runs the
# migration check (a second migrate applies nothing, the runtime role cannot create a table) and the scenarios of apps/server/test-e2e/m4 one after another (each prints `PASS <name>` or `FAIL <name>: <reason>` and writes test-results/m4/<name>.json).
# Covered requirements: R13.8 (the API through the generated client, its limits and its configuration route), R13.27 (the exit test of the milestone).
test-m4: dev-secret
	bun install --frozen-lockfile
	bun run build
	bun run tsc -b
	bun run openapi:check
	node apps/server/test-e2e/m4/surface-check.ts
	bun run typecheck
	bun run check:tsc-time
	bun run test
	node --test apps/server/test-e2e/m4/guards.test.mjs
	$(MAKE) up
	bun run test:conformance
	node apps/server/test-e2e/m4/migration-check.ts
	rm -f test-results/m4/*.json
	node apps/server/test-e2e/m4/run.ts

# BEGIN test-m5
.PHONY: files-setup test-m5
# Makes the bucket exist with the application's CORS rule, with the administrator identity of the development store (GRIMOIRE_DEV_S3_*, in .env). The command gets nothing but
# the settings it needs, so no other setting of .env reaches it; the running container never holds the administrator key.
files-setup: .env
	@set -a; . ./.env; set +a; \
	env -i PATH="$$PATH" HOME="$$HOME" \
	  GRIMOIRE_S3_ENDPOINT="$$GRIMOIRE_S3_ENDPOINT" GRIMOIRE_S3_BUCKET="$$GRIMOIRE_S3_BUCKET" \
	  GRIMOIRE_S3_ADMIN_ACCESS_KEY="$$GRIMOIRE_DEV_S3_ACCESS_KEY" GRIMOIRE_S3_ADMIN_SECRET_KEY="$$GRIMOIRE_DEV_S3_SECRET_KEY" \
	  GRIMOIRE_ALLOWED_ORIGINS="$${GRIMOIRE_ALLOWED_ORIGINS:-http://127.0.0.1:8080,http://localhost:8080}" \
	  node apps/server/dist/cli.js files-setup

# The milestone 5 exit test: files and attachments against the Compose stack in local mode (alice administrator, bob member, carol viewer) and the real file store. It checks the
# generated API surface and the compile time, runs the unit tests, the conformance tests of the file store port and the real-browser checks of the store (the browser is installed
# once with `bunx playwright install chromium`; without it the check says so and stops), checks the source rules of the scenarios, then runs the scenarios of
# apps/server/test-e2e/m5 one after another (each prints `PASS <name>` or `FAIL <name>: <reason>` and writes test-results/m5/<name>.json). The runner names every scenario first
# and exits 1 when the list and the scenario files differ. The application signs addresses for 127.0.0.1:8333, the store as the host reaches it.
# Covered requirements: R9.15, R9.23, R12.11, R13.8, R13.26.
test-m5: dev-secret
	bun install --frozen-lockfile
	bun run build
	bun run tsc -b
	bun run openapi:check
	bun run typecheck
	bun run check:tsc-time
	bun run test
	node --test apps/server/test-e2e/m5/guards.test.mjs
	GRIMOIRE_S3_PUBLIC_ENDPOINT=http://127.0.0.1:8333 $(MAKE) up
	$(MAKE) files-setup
	bun run test:conformance
	bunx playwright test -c apps/server/test-e2e/m5/browser/playwright.config.ts
	rm -f test-results/m5/*.json
	node apps/server/test-e2e/m5/run.ts
# END test-m5

# The web client's browser specs (apps/web/test-e2e) against the real stack: the workspace is built, the client is built in e2e mode (the development sign-in form
# exists in that mode and in development only), the stack starts with the web overlay (it allows the origin of the
# client's server, 127.0.0.1:$${E2E_WEB_PORT:-4173}), and the Chromium project of apps/web/playwright.config.ts runs. The development token comes from .env, as for the exit
# tests, and is handed to the run as E2E_DEV_TOKEN_SECRET: the specs that stand in for the API give that variable a made-up value when it is unset (`??=`), and
# in one run every spec file is loaded first, so without it the specs that sign in on the stack would sign with the made-up one and be refused (401). Needs the browser once: `bunx playwright install --with-deps chromium`. Reproduce a CI failure with `make test-web-e2e`; `make down-volumes` afterwards.
WEB_COMPOSE := COMPOSE_FILE=compose.yaml:compose.m6.yaml
test-web-e2e: dev-secret
	bun install --frozen-lockfile
	bun run build
	cd apps/web && bunx vite build --mode e2e
	$(WEB_COMPOSE) $(MAKE) up
	E2E_DEV_TOKEN_SECRET="$$(sed -n 's/^GRIMOIRE_DEV_TOKEN_SECRET=//p' .env)" bunx playwright test -c apps/web/playwright.config.ts --project=chromium

# Later milestones that run after this one and are not ordered against each other keep their targets in mk/test-mN.mk.
-include mk/*.mk
