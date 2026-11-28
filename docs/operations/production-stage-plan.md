# The production stage: a plan for approval

This is a plan, not a record. Nothing in it is created, changed or deleted until the owner approves it and the infra agent has a go from the manager. Every number below is either a value this repository declares (and a test pins) or an observation from the ledger's dev and staging deploys; where a figure is not observable from here, it says so instead of pretending to measure it.

Production is proposed as stage `production`, a **third row to add to** `infra/stages.json` (the file holds `dev` and `staging` today, and `stageConfig` throws for any other name), built by the same function as them (`infra/stage.ts`), with its own GitHub environment `production` holding the same six variables as the other two (`AWS_REGION`, `AWS_ROLE_ARN`, `DESCOPE_MANAGEMENT_KEY_ID`, `GRIMOIRE_ALLOWED_EMAIL_DOMAINS`, `GRIMOIRE_DOMAIN`, `GRIMOIRE_FIRST_ADMIN_EMAILS`). Adding the row is part of the prerequisite change in section 2, step 0: `tools/ci/test/stage-parity.test.mjs` also has to change, because it asserts the stages are exactly `['dev', 'staging']` and that only `staging` is protected (production is `protect: true` and still owns no VPC, so the test's statement about the VPC's owner must say what it means).

## 1. The stage, in the terms of `infra/stages.ts`

| Field | Value | Why |
|---|---|---|
| key (`GRIMOIRE_ENV`) | `production` | set by the table reader from the row's key; matches the `GRIMOIRE_ENV` rule (lowercase, at most 32 characters) |
| `name` | `Grimoire production` | the Descope project's name and tag source; must not equal `Grimoire dev stage` or `Grimoire staging` (a test refuses two stages with one project name) |
| `tag` | `production` | the project's Descope tag; also the `sst:stage` tag on the resources |
| `protect` | `true` | SST refuses to delete any resource of the stage; only the stage that owns the VPC must be protected, and production will not own it (section 4) |
| `localHosts` | `[]` | production approves no loopback host: local runs never sign in against it |
| `nat` | `ec2` | the same as staging, for one behaviour across stages (a managed NAT costs more per hour than the EC2 one at this traffic) |
| `vpcFrom` | `staging` | the shared VPC stays owned by staging (section 4); production reads it by the owner's tags and makes no VPC, NAT or address of its own |
| `service` | `0.5 vCPU`, `2 GB` | staging's size, the smallest that runs the product; `2 GB` is the collaboration memory guard's floor |
| `GRIMOIRE_SEMANTIC_SEARCH` | `off` | it needs about 3 GiB of model memory the task does not have; turning it on is its own decision and its own task size |
| hostname (proposed) | `app.grimoire.descope.io` | the zone is already used (`dev.grimoire.descope.io`, `grimoire.descope.io`); the exact name is open question Q1 |
| allowed email domains | from the environment variable, e.g. `descope.com` | production signs in the company's own domain only; the exact list is Q2 |
| first admin emails | from the environment variable | at least one; names the first administrator of the workspace bootstrap (Q3) |

The row is three lines of JSON. The rest of this document is about what that row turns into.

## 2. Its own Descope project

**Why its own project.** A Descope project holds the sign-in flow, the JWT template (the `dct` tenant claim and the profile claims), the styles, and every user and tenant of the stage. Staging's project already holds dev-only test users and the tenant structure created while testing; a production project that shared them would hand those users a production session, mix tenant data across stages, and make a staging experiment a production change. The repository already enforces one project per stage (`no two stages share a project name` test). Production gets its own, named `Grimoire production`.

One-off steps, each marked with who does it:

| # | Step | Who | Notes |
|---|---|---|---|
| 0 | **Prerequisite code change, before any `diff`:** add `production` to `descope-infra.yml`'s `stage` choices (today `dev` and `staging` only, so a dispatch with `stage=production` is refused); add the stage's row to `infra/stages.json` and update `tools/ci/test/stage-parity.test.mjs`, which asserts the stages are exactly `['dev', 'staging']`; and teach `infra/stage.ts` to create the Aurora cluster **on a stage's first deploy, without the instance beside it**: today line 35 declares `sst.aws.Postgres('Db')` unconditionally and line 38 adds the cluster only when `auroraSnapshot` is set, so a new stage would get a plain RDS instance and the `database_kind=cluster` check would fail | CI, one small PR, after the owner approves this plan (Q10) | the smallest shape that does not leave a paid instance behind: a required row field, `aurora`, that makes the cluster **instead of** `.Postgres('Db')`, empty and protected at `min 0.5`/`max 2 ACU`; the parity rule is section 8's: **a stage with `aurora: true` declares the cluster and no instance**, a stage with `false` behaves as today (the instance, and the cluster only when a snapshot is set), and no stage declares both |
| 1 | Create a GitHub environment `production` with the six variables above and a deployment rule that only `main` deploys it | owner or manager | the workflow reads the variables; without them its first step stops with a notice and the run stays green |
| 2 | Add the production environment's OIDC subject to the GitHub to AWS role's trust policy (`repo:tektum@271704328/grimoire@1466314324:environment:production`, immutable form) | owner | the other two environments already use that form (the name form was refused once) |
| 3 | Add the production environment's subject to the Descope federated management key's allowed subjects | owner | same key, same audience; no secret |
| 4 | First `diff` of the stage from `main` (creates the Descope project, its settings, the sign-in flow, the styles built from `infra/descope/theme.ts`, the tenant-claim template, the Aurora cluster, the bucket, the service, the log groups) | CI, after the owner's go | `action=diff stage=production`; read before any deploy |
| 5 | First `deploy` of the stage | CI, after a second go | the first deploy creates everything; the gate waits until the stage serves |
| 6 | Create the first administrator: sign in with one of the first-admin emails on the new project, which the flow provisions | owner | the bootstrap in the sign-in flow creates the workspace's tenant for the first admin |
| 7 | Turn off sign-in for any other domain in the project's settings, if the allowed-domain rule is not enough | owner | `GRIMOIRE_ALLOWED_EMAIL_DOMAINS` is enforced **by the app's provisioner** (`packages/core/src/users/provisioner.ts`), not by the Descope flow: nothing under `infra/descope` reads it, and the flow only screens public mail providers, so a user from another company domain can finish sign-up in the project and is refused by the app. Closing the project to the domains too is belt and braces |

The sign-in flow and the theme are the ones in the repository (`infra/descope/flows/sign-up-or-in.json`, `infra/descope/theme.ts`): the same flow dev and staging run, so what is tested on staging is what production gets. The theme's tokens come from `apps/web`'s design tokens, so the redesign's colours reach production's sign-in page on the first deploy after they are on `main`.

## 3. What AWS resources it adds

Staging declares 49 resources in its recorded form (the `staging-declarations` fixture); dev declares 43, because it already borrows staging's VPC and so has no VPC, flow log group, flow-log key, flow-log role or default security group (`infra/stage.ts` calls `vpcFlowLogs` only when `config.vpcFrom === undefined`). **Dev, not staging, is production's template.** Production adds one thing dev does not have: the Aurora cluster in place of the instance (step 0). The resources with a monthly cost are these.

| Resource | Setting (declared) | Cost shape |
|---|---|---|
| Aurora Serverless v2, PostgreSQL 17.9, **in place of the instance** | `min 0.5 ACU`, `max 2 ACU`, always on (never pauses: the job queue and the health checks keep it busy). Replaces `sst.aws.Postgres('Db')` only after the code change in step 0; until then a new stage gets the instance | ACU-hours; 0.5 ACU at rest is 360 ACU-hours a month, 2 ACU all month is 1,440 |
| Storage | Aurora's own, grows from zero; the dev and staging clusters were restored from snapshots of instances holding 1 to 2 pages, so the starting point is small | GB-month |
| Fargate service | one task, `0.5 vCPU`, `2 GB`, `min 1 max 1` (the migration lock makes a second task only wait) | vCPU-hours and GB-hours, 730 hours a month |
| Application load balancer | one, HTTPS, access logs to its own bucket (90-day expiry, `infra/stack/edge.ts`) | hourly plus LCU-hours plus S3 PUTs and storage |
| S3 | one Files bucket (CORS from `infra/stage.ts`, an `abort-incomplete-multipart` lifecycle rule at 2 days) plus the load-balancer log bucket (90-day expiry) | storage and requests |
| CloudWatch | the task's own log group and the database's logs; **not** the VPC flow log group, which belongs to the VPC's owner (staging, `infra/stack/network.ts`, called only when `config.vpcFrom === undefined`) | GB-month, the task's logs being the line to watch |
| KMS | none of its own: the flow log group's key is staging's (same function) | none |
| NAT | the shared VPC's EC2 NAT is staging's; production adds no NAT of its own but sends its traffic through it | none of its own, some of staging's data processing |
| Route 53, ACM | one hostname in the existing zone, one certificate | per zone query and per certificate |

**What is measured today, and what is not.** The ledger records the two Aurora moves (dev 66 minutes of downtime, 33 of them the restore; staging 43 minutes, the restore shorter) and the rolling deploys (about 9 minutes for staging, 3 of them the gate). It records **no** ACU, task or storage figure, and the metrics reachable here cannot add one: they carry the load balancer's series and the forwarded log lines for this account, and **no RDS, ECS or S3 series** (checked: every `aws.rds.*`, `aws.ecs.service.*` and `aws.s3.bucket_size_bytes` query returns nothing for this account, or another account's buckets). So the monthly range below is computed from the declared settings and list prices, not read from a bill.

**An estimate, on explicit assumptions.** Prices are us-east-1 list prices as of this writing, rounded; the arithmetic is in the open so a wrong price is easy to correct.

- Aurora Serverless v2 at the `0.5 ACU` floor: `$0.12` per ACU-hour, so 0.5 ACU for 730 hours is 365 ACU-hours, about `$44` a month. At a steady `1 ACU` it is about `$88`; at the `2 ACU` ceiling, sustained, about `$175`. Idle production with a handful of editors should sit near the floor.
- Aurora storage and I/O: small at first (single-digit GB), tens of cents.
- Fargate `0.5 vCPU` + `2 GB`, 730 hours: `$0.04048` per vCPU-hour and `$0.004445` per GB-hour, which is `$0.02913` an hour, about `$21` a month.
- ALB: `$0.0225` an hour, about `$16` a month, plus LCU-hours; with two health checks a minute and light traffic, a few dollars more.
- NAT data processed through staging's EC2 NAT: cents to a few dollars.
- S3: pennies at first; the load-balancer log bucket grows with traffic and expires at 90 days.
- CloudWatch: production's own task and database logs, GB-month; the **365-day VPC flow log group belongs to staging** (the VPC's owner, `infra/stack/network.ts`), so it is not a production cost and shortening it is a change to dev too (Q5).
- Route 53 and ACM: a few dollars.

**Estimated total: about `$85` to `$105` a month empty, and about `$135` to `$170` with a steady `1 ACU` and normal use**, dominated by the Aurora floor and the load balancer (Aurora `$44`, Fargate `$21`, ALB `$16`, before storage, task logs, S3 and DNS; the VPC flow log group is staging's and is not in this figure). The single figure to set is the Aurora ceiling (Q4); the one retention that grows without a ceiling is staging's flow log group (Q5).

## 4. What stays shared, and what must not

| Shared | Why it is safe | What must not be shared | Why |
|---|---|---|---|
| the VPC (`vpcFrom: staging`) | a VPC is addresses and routing, no data; the owner's rule is one VPC per account and the repository's test requires exactly one owner | the database | a shared cluster means a shared failure, a shared connection budget and a migration lock across stages; each stage has its own cluster and its own snapshot |
| the GitHub to AWS role (OIDC, no secret) | each environment's subject is listed; the role holds no long-lived key | the S3 bucket, or even a prefix of it | one bucket's policy and lifecycle apply to all of its keys; a staging prefix in production's bucket would let a staging bug delete production objects; each stage declares its own bucket (`Files`) |
| the Descope federated key | scoped to the environments' subjects | the Descope project | section 2: users, tenants and the flow are per stage |
| the Route 53 zone | one zone, one certificate per hostname | the hostname | one address per stage |
| the deploy workflow | one workflow, two inputs | the GitHub environment's variables | a stage's secrets and domain are its own |

Production additionally keeps the old-instance rule: when (and only when) a stage's database is moved again, the instance it came from stays with `deletionProtection` on as the way back, exactly as dev and staging do now.

## 5. Cut-over and rollback

**The cut-over is a first deploy, not a migration.** Production has no data and no old instance, so the risky steps the other two stages ran (freeze, snapshot, restore, thaw) do not apply to it. What does apply:

1. **`diff` first** (`action=diff stage=production`), read against this plan: expect the creates this document lists and nothing else. A `Replaced` on any resource is a hard stop.
2. **Deploy** (`action=deploy stage=production`), after the owner's approval and the manager's go; the workflow's own gate must report 3 of 3 on the new task definition, and readyz must answer during the roll.
3. **Check** (`action=check stage=production`): `database_kind=cluster`, PostgreSQL 17.9, pgvector 0.8.1, **16 row-level-security tables** with their policies (`0014` enables 15: 14 tenant tables plus `tenants`; `0015_import_parts` adds `import_parts`), and the page and user counts. The check does **not** print the applied migration (`tools/deploy/db-check.js` prints versions, extensions, counts and the RLS rows), and the workflow prints no `migrate` exit status either. What proves the migration: `infra/stack/init-order.ts` starts the `app` container only when `db-setup` and then `migrate` exit 0 (`dependsOn` with `condition: 'SUCCESS'`), so the gate passing and `/readyz` answering 200 (it reads `grimoire_schema_version()` and answers `migration_pending` when the newest shipped migration is not applied) are the evidence, together at once.
4. **First sign-in** by the first administrator, the flow creating the workspace's tenant; then a page, a save and a search, the same walk-through staging had.

**Rollback, in the order it would be used:**

| Situation | Action | Notes |
|---|---|---|
| the `diff` shows anything not in this plan | stop before deploying | nothing exists yet, so there is nothing to undo |
| the first deploy fails before the service starts | `action=thaw stage=production` if the service was frozen, then read the log | the stage is new; a failed first deploy leaves resources that can be deleted with the stage (`removal: retain` keeps them, so they need an explicit removal, Q7) |
| the service does not pass the gate | `action=freeze stage=production` (stops the service so nothing writes), keep the database and bucket, fix forward | the database is empty enough that a re-create is also cheap this early |
| a later deploy breaks production | the same `freeze`, then the previous task definition, then the previous diff | never delete a database or a bucket as a rollback: keep them |
| a later change to the cluster (ACU bounds) | a normal `diff` and `deploy`, with `freeze` first if the change restarts the cluster | **not** the instance-to-cluster procedure: from the moment the cluster exists, `GRIMOIRE_AURORA_SNAPSHOT` seeds nothing more (`ignoreChanges: ['snapshotIdentifier']`) and its ARN must be an instance snapshot, which a cluster does not have |
| a later engine version (`POSTGRES_VERSION`) | its own change, planned for **every** stage at once | `POSTGRES_VERSION` is one constant used by `Db` (line 35) and `DbCluster` (line 40), so a bump upgrades dev's and staging's clusters **and** the retained instances kept as their way back. It is not a production-only diff, and a cluster snapshot is not a way back from it: the snapshot restores the cluster that was upgraded, at the version it was taken. The engine change is its own plan with its own restore check |

**Hard stops, the same list the other stages ran under:** a `diff` beyond the planned creates (or a `Replaced` at all); a failed `db-setup` or `migrate`; a gate short of 3 of 3; readyz failing during a roll; and, once the stage holds data, counts or the 16 policy rows differing from a check before. On any of them the infra agent reports and does nothing else without a new go, and **thaws only when something was actually stopped**: a stop after a deploy (a gate failure, readyz failing, a check that differs) thaws first so the app is not left stopped, while a stop before or at the `diff` thaws nothing, because `tools/deploy/freeze.sh` refuses a thaw when the stage's cluster and service do not exist yet. A first deploy of an empty stage has no "check before": its check is the 16 rows, the counts, and readyz answering 200 after a successful `migrate`; its correctness is the declared shape being the one the `diff` showed.

## 6. Open questions, with defaults

| # | Question | Default if no answer |
|---|---|---|
| Q1 | Which hostname? `app.grimoire.descope.io` is proposed; `grimoire.descope.io` is taken by staging | `app.grimoire.descope.io` |
| Q2 | Which email domains may sign in? | the company domain already in use on staging |
| Q3 | Which address(es) are the first administrator? | the owner's own address |
| Q4 | What Aurora Serverless v2 ceiling? `2 ACU` is what dev and staging declare; production could take `1 ACU` to cap cost. Only reachable after the code change in **section 2 step 0** | `2 ACU`, the same as the other stages |
| Q5 | The VPC flow log group's **365-day** retention belongs to the VPC's owner, staging (`infra/stack/network.ts`), so shortening it to cap the line that grows changes dev as well. Shorten it for all three, or leave it? | leave it, 365 days |
| Q6 | `protect: true` (SST refuses to delete any resource of the stage) is the plan; confirm | `true` |
| Q7 | When a first deploy fails and the stage must be removed, may CI delete the stage's resources (`removal` is `retain` today, so removal is explicit and manual)? | owner does it, once, by hand |
| Q8 | Semantic search in production: this plan keeps it **off** (the model needs a bigger task) | off |
| Q9 | The load-balancer log bucket expires at 90 days (production's own); the VPC flow log group's 365 days belongs to staging, so a change there affects dev too (Q5). Is 90 days the retention wanted for the load-balancer logs? | as today |
| Q10 | The plan needs three code changes before a `diff` can even show what it describes (**section 2 step 0**): the `production` row in `stages.json` together with the parity test that names the stages, Aurora created on a first deploy instead of only from a snapshot, and `production` added to the workflow's stage choices. Approve those as one small PR first? | yes, one small infra PR, then the `diff` |

## 7. What this plan does not claim

- It does not claim any measured cost: this account's metrics here have no RDS, ECS or S3 series, and no bill was read. The range in section 3 is arithmetic on declared settings and list prices.
- It does not claim a downtime: a first deploy of an empty stage has no users to interrupt. The 43-minute staging `freeze`-less roll and the 66-minute dev move were database restores, and neither applies here.
- It does not claim the sign-in page's fonts were seen: the theme's tokens are checked by a test and by the staging deploy, but the rendered page needs a sign-out to look at (noted by the manager on the last deploy).

## 8. What step 0 touches, exactly

Read from the code, so the small PR has no surprises:

- **`infra/stages.json`:** one row. `production`: `name` and `tag` as section 1, `protect: true`, `localHosts: []`, `nat: "ec2"`, `vpcFrom: "staging"`, `service: { "cpu": "0.5 vCPU", "memory": "2 GB" }`, and **`"aurora": true`**, the row field that makes the stage declare the cluster instead of the instance. It is a field of `StageConfig`, required (dev's and staging's rows gain `"aurora": false`), not an environment setting: nothing about it is secret or per-deploy, and a `diff` must be able to show it. With `false` a stage behaves as today (`Db` only, and `DbCluster` only when a snapshot is set).
- **`infra/stage.ts`:** line 35's `sst.aws.Postgres('Db')` and line 38's `auroraSnapshot === undefined ? ... : new sst.aws.Aurora('DbCluster', ...)` become one choice: with the new flag the stage declares the cluster (the existing `DbCluster` component, created empty rather than from `snapshotIdentifier`, `min 0.5`/`max 2 ACU`, protected) **and not** the instance; without it, today's behaviour is unchanged. Nothing else needs to move: line 53 already resolves `const database = aurora ?? db`, so every consumer below it keeps working unchanged.
- **`infra/stages.ts`:** the `StageConfig` field for the flag (`readonly aurora: boolean`, so every row must state it), its validation, and `env`-style treatment: the table reader already adds `env` from the key, and this stays a value of the row. Dev's and staging's rows gain `"aurora": false` for the same-fields test above; their behaviour is unchanged, because `false` means today's path.
- **`tools/ci/test/stage-parity.test.mjs`:** the new row breaks five tests, and each needs a named decision rather than a blanket loosening. (1) Line 19's `NAMES` literal becomes the three keys in `stages.json` order, and line 23's error message names all three. (2) Line 22's `protect` assertion becomes the two protected stages in that same order. (3) Lines 20 to 21's same-fields check (`shape()` counts every key except `vpcFrom`) fails when only production carries `aurora`: the honest fix is to give every row the field explicitly (`aurora: false` on dev and staging), not to exclude it from `shape`, so the shape stays uniform and the difference is data. (4) Lines 110 to 114's pinned-version test asserts exactly one `sst.aws:Postgres` per stage; it must accept a stage that declares a cluster instead, and assert the cluster's `version` is `POSTGRES_VERSION` for production. (5) The snapshot test (lines 116 to 137) asserts at line 121 that a stage with no snapshot records **no** cluster; production has no snapshot and does record one, so that test must say "no cluster unless the stage has a snapshot **or** `aurora: true`", and a new test covers the flag's own shape. Also, **lines 44 to 50 (the Descope parity test)** build a `projectConfig` for every name in `NAMES` from `const settings = { dev, staging }`, so a third name makes `projectConfig` receive `undefined` and throw at `infra/descope/config.ts:58`'s `HOST.test(domain)`; it compares only `configs[0]` and `configs[1]` and asserts an `appUrl` list of two, so it must loop over all three with production's address added. The VPC-owner test needs no change: it derives the owner from `vpcFrom` and only pins `stages.dev.vpcFrom`. And a new test asserts that no stage declares both the instance and the cluster.
- **`tools/ci/test/fixtures/staging-declarations.json`:** unchanged, because staging keeps its instance-and-cluster pair exactly as today; a second fixture for production would be the honest way to pin the new shape if the reviewer wants one.
- **`.github/workflows/descope-infra.yml`:** `production` added to the `stage` choices, and the two `dev`/`staging`-only descriptions updated.

What it does **not** touch: the **behaviour** of dev and staging, their clusters and instances, the VPC, the workflow's actions, and anything in AWS (the PR is code and tests only; the first `diff` is a separate go). It does edit their rows in `stages.json`, to add `"aurora": false`, which is why they are not in the "untouched files" list.
