# Agent instructions

Grimoire is a collaborative documentation tool. People write pages together in
a WYSIWYG editor, and every page is stored as Markdown. It is built for the
staff of one company, who sign in through the company login.

It is built in the open, one small pull request at a time. The tree is still
growing, so some parts named below may not exist yet. This file lists only what
exists, and each new part adds its own line here.

[CONTRIBUTING.md](CONTRIBUTING.md) holds the contribution rules. These
instructions add what an agent needs on top of them. This file follows the
AGENTS.md convention, so there is no tool-specific instruction file. Procedures
(skills) live in `.agents/skills/<name>/SKILL.md`, the cross-tool skills location
that OMP reads:
`small-pull-request`, `answer-review`, `verify-claim`, `add-allow-list-entry`
and `pull-request-visuals`. Use the one that matches your task.

## Set-up

- Install [mise](https://mise.jdx.dev), then run `mise install` in the
  repository root. Tools (node and the others) come from `mise.toml` only.
  Never install a project tool globally or by hand.
- Run commands with `mise exec -- <command>`, or activate mise in your shell.
- Then run `mise exec -- bun install --frozen-lockfile`.
- Node 26 is required (`engines` in `package.json`).

## Commands

Run from the repository root. Each line works on `main` today.

| What | Command |
| --- | --- |
| Lint (ESLint, then the sleep check) | `bun run lint` |
| Typecheck | `bun run typecheck` |
| Build | `bun run build` |
| Unit tests | `bun run test` |
| Tests of the repository tools | `bun run test:tools` |
| Integration tests | `bun run test:integration` |
| Container tests | `bun run test:container` |
| Benchmarks | `bun run test:benchmark` |
| Licence check (installed packages and the recorded rest) | `bun run licence` |
| Licence check of the container base images | `bun run licence:check-images` |
| Start PostgreSQL and the file store (Compose project `grimoire`) | `make db-up` |
| Stop the stack, keep the data | `make down` |
| Stop the stack and delete its data volumes | `make down-volumes` |
| Sleep check alone | `node tools/ci/check-test-sleeps.mjs` |
| Secret scan, history | `gitleaks git --config .gitleaks.toml --redact .` |
| Secret scan, files | `gitleaks dir --config .gitleaks.toml --redact .` |

`mise.toml` lists node, bun, gitleaks, actionlint and zizmor, with their checksums in
`mise.lock`. A tool missing from `mise.toml` is added there in a pull request.

Today the integration, container and benchmark commands find no tests and exit
with success. They start to matter when the first such tests arrive. The
integration tests need the database and the file store: run `make db-up` first.

The list grows. Each later slice adds its line here: the
exit tests (`make` targets). Do not document a command that is not on `main`.

CI runs lint, typecheck, build, unit tests, the tool tests, the licence check,
the Compose file check, the integration tests (against the Compose database and
file store) and the secret scan. It does not run the container or benchmark
tests, and a pull
request that changes only documentation skips the static and unit jobs. A green
`CI Required` is therefore not proof that the other suites pass: run them
yourself when your change can affect them. The required check is `CI Required`.

## Agent configuration

`.omp/config.yml` is the project configuration that OMP reads. YAML allows
comments, but each key is explained here as well.

- `bash.patterns`: one `allow` rule per command in the table above, bare or
  wrapped in `mise exec --`, matched literally with no extra arguments, except
  the `make` rows: those pull images and create or delete Docker volumes, so
  each use is approved. Allowed commands run without asking. Nothing that
  writes outside the repository or touches the network is listed. This is an
  approval policy, not containment.
- Skills need no setting: OMP finds `.agents/skills/<name>/SKILL.md` one level
  deep, walking up from the working directory to the repository root. Do not
  nest skills in sub-folders.

OMP has no project setting that denies edits to named files or reads of named
files, so these are rules for you:

- Never edit `bun.lock` (change `package.json` and run `bun install`) or
  anything under a `dist/` directory (generated).
- Never read `.env` files at any depth; `.env.example` is the template.

## Where things live

- `packages/core`: the domain. Ports (interfaces) in `src/ports` (clock, config,
  logger, database, Markdown converter, user store, auth verifier, access store,
  collaboration host), in-memory fakes in `src/testing`, the access decision and
  authoriser in `src/authorize`, tests in `test/`.
- Adapters (database, auth, storage, and so on) live in their own packages
  under `packages/adapters/*`. Today: `config-env` (reads the environment into the
  typed config, the only place that reads `process.env`), `logger-json` (JSON logs
  with a secret scrubber that fails closed), `db-kysely` (PostgreSQL
  migrations in `db/migrations`, the page store and the permission queries),
  `auth-fake` and `auth-dev` (fake and development sign-in). The others arrive
  later.
- Apps live in `apps/*`: `apps/web` (the web client) and `packages/api-client`
  exist today as empty placeholders.
- `packages/test-support`: the shared test harness (database helpers, a test
  client, and `eventually`, the helper that waits for a condition instead of
  sleeping). Tests use it rather than their own timers.
- `tools/ci`: repository checks, with their own tests (`bun run test:tools`).
- `.github/workflows`: CI. Change it only on purpose.

## Architecture rules (tests and lint enforce them)

- The core imports no provider SDK or runtime library (the list is in
  `eslint.config.js`). It talks to the outside only through ports. ESLint and
  the boundary tests in `packages/core/test/boundaries` fail the build
  otherwise.
- The core also imports no adapter package, and adapters import no other
  adapter and nothing from `apps/`. `packages/core/test/boundaries/adapter-imports.test.ts`
  enforces this, and `lint-fixtures.test.ts` checks that each rule fires on a
  sample file (the samples are the `.ts.txt` files in `fixtures/`).
- The core never reads `process.env`. Only a config adapter reads it.
- Server-only libraries stay out of the browser client and shared libraries.
- Every port gets an in-memory fake next to the others in `src/testing`, no later
  than the first code whose tests depend on that port. Today the clock, config,
  logger, database, Markdown converter, user store and access store have one. The
  auth verifier's fake is the `auth-fake` adapter (`auth-dev` signs development
  tokens), and the collaboration host
  and page store get theirs (an in-memory page store) with the collaboration
  adapter.
- A forbidden import is fixed by adding or using a port. Never loosen the rule.

## House rules

- **No test sleeps without a reason.** Wait for a condition (`vi.waitFor` or a
  helper that polls). The sleep check refuses fixed delays above 250 ms and
  every `setInterval` in tests. An exception is an entry in
  `tools/ci/test-sleep-allow.json` with `file`, the exact `line` text and a
  non-empty `reason`. Stale entries fail the check.
- **Licences: permissive only** (Apache-2.0, MIT, BSD, ISC and similar). Never
  add a copyleft dependency. `bun run licence` runs in CI: it refuses copyleft in
  shipped code and allows MPL-2.0 only for development-only tools. After a
  dependency change, run `node tools/licence-report/record-licences.mjs` and commit
  `tools/licence-report/lock-licences.json`.
- **No secrets.** Never commit tokens, keys or credentials, and never paste them
  into a pull request. Gitleaks runs in CI on history and files. If a test
  fixture must look like a secret, add an allow-list entry to
  `.gitleaks.toml`: scoped to the path and the rule, with a comment saying why.
  Never add a blanket entry such as a whole directory for all rules.
- **Use established libraries.** Do not hand-write infrastructure that a
  well-kept, permissively licensed library already covers. If you must write it
  yourself, say why in one line in the code or the pull request.
- **New tools go in `mise.toml`.** Do not install a tool ad hoc.
- **Originality.** Write our own code and words. Copy nothing from other
  projects. Do not name other products or companies in files, commit messages
  or pull requests. Libraries we depend on and the sign-in service we integrate
  with are fine to name.
- **Package manager.** bun is the package manager and Node is the runtime. Run
  scripts with `bun run <script>`, install with `bun install`, and use `bunx` for
  one-off tools. Never run npm or its package runner. Automation installs with
  `bun install --frozen-lockfile`.
- **Public text.** Plain English and short sentences. No local paths, machine
  names, agent or model names, or private links. Link only to files that exist
  on `main`.
- Never edit `bun.lock` by hand. Change `package.json` and run
  `bun install`. Never edit generated output (`dist/`).

## Pull requests

- One concern per pull request. Keep it small enough to review in one sitting.
- Conventional Commits for the title (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:`). The squash merge uses it as the commit message.
- Fill in the template: what changed, why, how it was verified, visuals,
  checklist.
- Visuals: a feature attaches screenshots; a bug fix attaches a before and an
  after shot; tooling-only changes say "not applicable" and why.
- Review comments: read all of them, through the API. Answer every thread with
  a fix (name the commit) or a reason. Resolve the thread you answered. Never
  dismiss a security finding without checking it against the code.
- Auto-merge with squash once checks pass. `main` needs a pull request, one
  approval, resolved conversations and `CI Required`. Never bypass these.
- Stacked pull requests: after the base is squash-merged, rebase onto `main`
  with `git rebase --onto origin/main <old-base> <branch>`.

## Definition of done

Do not trust a claim, including your own. Check on the real thing.

1. Write the test first. See it fail for the right reason.
2. Make it pass. Prove the test can fail: break the code on purpose and watch it
   go red, then restore it.
3. Run the full gate (lint, typecheck, build, unit tests, tool tests, secret
   scan) from a clean checkout. Count the results from the finished run.
4. Report results with what was NOT verified first. Then what passed, with
   counts.
5. When the Compose stack exists, verify against it, not only against fakes.

## Docker safety

- Use only this project's Compose stack, through the `make` targets. Never run
  raw `docker` commands that touch other containers, images or volumes.
- Never prune (`docker system prune`, `docker volume prune` and the like).
- One stack at a time. While a gate runs, nothing else may touch Docker.
- Tooling can recreate containers when a Compose file changes. Bring the stack
  down before you edit it.

## Working together

- Before editing a checkout another agent used, make sure that agent is
  stopped and its processes are gone.
- Split big tasks by part. Commit each part after it passes, so the next part
  starts from a clean tree.
- Check the installed tool's `--help` before saying it cannot do something.

## Stop and ask

Stop and ask the maintainers before you:

- change product behaviour that a task did not ask for;
- make a security decision (a new trust boundary, a weaker check, an
  allow-list for a finding);
- change repository settings, rules, secrets, or anything outside the
  repository;
- add a dependency with an unclear licence.

## Nested instructions

None yet. A nested `AGENTS.md` is added only when a directory has rules of its
own. Likely later: `packages/adapters` (adapter conformance tests), `apps/web`
(client rules and screenshots), `apps/server`.
