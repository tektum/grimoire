# M7 targets. The M7 exit test (M7-T07) adds its own here.

# pgvector 0.8.7 (Q60 = A): the semantic tests also run on the second image the plan was measured on. The default image of `make up` is 0.8.5, what Cloud SQL for PostgreSQL 17 offers.
# This starts the 0.8.7 image in a project of its own (volume included), runs the tests that need pgvector, and removes it again, also when they fail. Stop the stack first: port 55432.
# The test files are the ones named in the contracts that exist; M7-T11 and M7-T01 add theirs to PGVECTOR_TESTS with the files.
PGVECTOR_087 := docker compose -p grimoire-pgv087 -f compose.yaml -f compose.pgvector087.yaml
PGVECTOR_TESTS := apps/server/test/migrations/semantic/pgvector.int.test.ts

# Startup and tests share one guarded command: the project (container, volume, port 55432) is removed whatever fails, and the status of the first failure is the target's.
.PHONY: test-pgvector-087
test-pgvector-087: .env dev-secret
	$(PGVECTOR_087) up -d --wait --wait-timeout 120 postgres && GRIMOIRE_TEST_PGVECTOR_VERSION=0.8.7 bunx vitest run --project integration $(PGVECTOR_TESTS); status=$$?; $(PGVECTOR_087) down -v --remove-orphans; exit $$status
