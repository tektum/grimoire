# COMPOSE_FILE (for example compose.yaml:compose.offline.yaml) is honoured; the project name is fixed.
COMPOSE := docker compose -p grimoire

.PHONY: db-up db-down down down-volumes test

# Compose reads .env for the development passwords and keys; .env.example is the single place they are written down.
# Hand-written: Compose has no "copy a default env file" feature.
.env:
	cp .env.example .env
	chmod 600 .env

# Development tokens carry a per-checkout secret (GRIMOIRE_DEV_TOKEN_SECRET): generated on first use, never a fixed default, kept in the ignored .env
# (mode 600). 32 bytes from the kernel's CSPRNG (/dev/urandom), hex encoded (64 characters). An existing value is never rewritten.
# Every target that starts the app or reads its environment depends on this one (compose-settings.test.ts checks `up` reaches it).
.PHONY: dev-secret
dev-secret: .env
	@chmod 600 .env
	@grep -q '^GRIMOIRE_DEV_TOKEN_SECRET=.' .env || { [ -z "$$(tail -c1 .env)" ] || echo >> .env; echo "GRIMOIRE_DEV_TOKEN_SECRET=$$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env; echo "generated GRIMOIRE_DEV_TOKEN_SECRET in .env"; }

# NOTE: database initialisation scripts (db/init) run only on an EMPTY volume. A database volume created before
# the roles or passwords changed must be reset with `make reset` (or `make down-volumes`, which deletes the data) before the next `make up` or `make db-up`.
db-up: .env dev-secret
	$(COMPOSE) up -d --wait --wait-timeout 120 postgres seaweedfs


# Stops and removes the containers and the network; the data volumes stay, so `make up` brings the same data back.
down:
	$(COMPOSE) --profile tools down --remove-orphans

db-down: down

# The only targets that delete data (database and file store volumes).
down-volumes:
	$(COMPOSE) --profile tools down -v --remove-orphans

test:
	bun run test

