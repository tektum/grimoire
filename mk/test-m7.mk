# M7 targets: the exit test of search, jobs and import (M7-T07), the real-export check (M7-T08) and the pgvector 0.8.7 run. The Makefile does not change for them: `-include mk/*.mk` takes this file.

# pgvector 0.8.7 (Q60 = A): the semantic tests also run on the second image the plan was measured on. The default image of `make up` is the pgvector 0.8.5 the production database must offer.
# This starts the 0.8.7 image in a project of its own (volume included), runs the tests that need pgvector, and removes it again, also when they fail. Stop the stack first: port 55432.
# The test files are the ones named in the contracts that exist; M7-T11 and M7-T01 add theirs to PGVECTOR_TESTS with the files.
PGVECTOR_087 := docker compose -p grimoire-pgv087 -f compose.yaml -f compose.pgvector087.yaml
PGVECTOR_TESTS := apps/server/test/migrations/semantic/pgvector.int.test.ts

# Startup and tests share one guarded command: the project (container, volume, port 55432) is removed whatever fails, and the status of the first failure is the target's.
.PHONY: test-pgvector-087
test-pgvector-087: .env dev-secret
	$(PGVECTOR_087) up -d --wait --wait-timeout 120 postgres && GRIMOIRE_TEST_PGVECTOR_VERSION=0.8.7 bunx vitest run --project integration $(PGVECTOR_TESTS); status=$$?; $(PGVECTOR_087) down -v --remove-orphans; exit $$status

# The exit test of milestone 7, from a clean checkout with Docker and no secret:
#   bun install --frozen-lockfile && make down && make up && make test-m7 && make down && bun run licence
# It builds, checks the generated API surface, checks the test list (every group of the exit test is named and every file it names exists: apps/server/test/m7/groups.json) and runs the groups one after
# another against the stack that `make up` started: search, jobs, hostile, synthetic, remote-images, restart, semantic and security (the policy walk). A group that fails does not stop the others; the
# target exits 1 if one did. The restart scenario recreates the application container, so it needs the stack `make up` started and the file store's bucket (`make files-setup`, done here). The semantic group includes the real-model container tests, so the models are fetched first (`scripts/fetch-models.mjs`: only what is missing, each file checked against models/models.lock.json). Files that are not written yet are listed as PENDING in the run and in docs/proof/m7-exit.md. The real Notion export is not part of it: `make test-m7-real`.
.PHONY: test-m7
test-m7: dev-secret
	bun run build
	bun run openapi:check
	node apps/server/test/m7/groups.mjs check
	node scripts/fetch-models.mjs
	$(MAKE) files-setup
	GRIMOIRE_MODEL_DIR="$(CURDIR)/models" node apps/server/test/m7/groups.mjs run

# The owner's real Notion export (M7-T08): test-data/notion-real/export.zip, gitignored, never in CI and never part of `make test-m7`. Without it the target says so and exits 0. With it the checks
# of M7-T08 run; until they are written the target exits 1 and says so (an export it cannot check must not pass).
M7_REAL_EXPORT ?= test-data/notion-real/export.zip
.PHONY: test-m7-real
test-m7-real:
	@if [ ! -f "$(M7_REAL_EXPORT)" ]; then echo "blocked: no export provided"; exit 0; fi; \
	echo "export found at $(M7_REAL_EXPORT): its checks are M7-T08's and are not written yet"; exit 1
