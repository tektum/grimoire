# Infrastructure (SST)

One [SST](https://sst.dev) app, `grimoire` (`sst.config.ts` at the repository root, the resources in this folder), one stage for each environment. SST keeps its state in the AWS account it is deployed to (its "home"), not in the repository. The Descope provider is `@descope/pulumi-descope` (Apache-2.0), which wraps the Descope Terraform provider.

Every stage is the same stack, built by one function (`stage.ts`) from its row in `stages.json` and the variables of its GitHub environment: one Fargate task behind an HTTPS load balancer, its own PostgreSQL database and file bucket, and its own Descope project. The stages differ in that data and in nothing else; nothing in `infra/` or `sst.config.ts` looks at a stage's name (`tools/ci/test/stage-parity.test.mjs` checks it, and records the resources of `dev` and `staging` to show they match). What is tested on `dev` is what is promoted to `staging`, the same commit deployed to each in turn.

| Stage | Address | Size of the task | Descope project | Protected |
|---|---|---|---|---|
| `dev` | its own, `GRIMOIRE_DOMAIN` of the environment `dev` | 0.25 vCPU, 2 GB | "Grimoire dev stage" (also approves `127.0.0.1` and `localhost`, so that a local run signs in against it) | no |
| `staging` | `GRIMOIRE_DOMAIN` of the environment `staging` | 0.5 vCPU, 2 GB | "Grimoire staging" | yes |
| `production` | `GRIMOIRE_DOMAIN` of the environment `production` (planned: `app.grimoire.descope.io`) | 0.5 vCPU, 2 GB | "Grimoire production", the project marked `environment: production` | yes |

A new stage is a row in `stages.json` and a GitHub environment with the variables below. Local runs (`make up`) stay in Compose and take the project id of `dev` (`GRIMOIRE_DESCOPE_PROJECT_ID`). A row's `aurora` says whether the stage's database is the serverless cluster and no instance (`true`, for a stage with nothing to restore from) or the instance alone (`false`, and a stage given `GRIMOIRE_AURORA_SNAPSHOT` keeps that instance as the way back beside the cluster); a row's `production` marks the customer-facing stage, whose Descope project is the one flagged as production.

## One Descope project for each stage, all of it code

`descope/project.ts` creates the project of a stage and everything in it; nothing is edited in the console. `descope/config.ts` holds what a stage is made of as plain data (tested), and `descope/theme.ts` makes the styles from the web client's design tokens (`apps/web/src/ui/tokens.css`: accent, paper, ink, fonts and radius, light and dark), so a change to the tokens changes the sign-in screens at the next deploy.

| In the project | Resource | Setting |
|---|---|---|
| the project | `Project` | named for the stage, protected from deletion, no `environment` (it is set to `production` for a production project) |
| address | `ProjectSettings` | app URL and approved domains: `https://<GRIMOIRE_DOMAIN>`, with `127.0.0.1` and `localhost` besides for a stage whose row lists them, for staging (hosts only; the provider takes no port) |
| sign-in | `OtpSettings` and the flow `sign-up-or-in` (`descope/flows/sign-up-or-in.json`) | a one-time code by email, and nothing else |
| other methods | password, magic link, enchanted link, embedded link, TOTP, passkeys, OAuth | all off |
| sessions | `SessionSettings` | session token 10 minutes (the server accepts up to a day), refresh token 3 weeks, rotating |
| look | `Styles` | the design tokens |

The flow is the Descope template "Sign up or in - OTP or sniper email link" (one-time code by email, with a shortcut to the reader's mail inbox), checked with the management API's `ValidateFlow` and kept as a file so a change to it is a pull request. The id of each stage's project is the stack's output (and an SST link), so the application takes it from there, not from a variable set by hand.

## The site (`stage.ts`)

One Fargate task (the image of the `Dockerfile`, which serves the web client and the API on port 8080) behind an HTTPS load balancer at `GRIMOIRE_DOMAIN`, with the Route 53 zone of that domain looked up (never made), a certificate validated through it, and an HTTP to HTTPS redirect. The load balancer checks `/readyz`.

| Part | Resource | Notes |
|---|---|---|
| network | `Vpc` | private subnets, one NAT instance (cheaper than the managed gateway), shared by every stage: the stage without `vpcFrom` in `stages.json` makes it (and is protected), the others read it by the owner's tags. A stage of its own would need two more Elastic IPs |
| network | two security groups per stage | the database takes 5432 from its own stage's service group alone, and the service takes its port from its own load balancer alone, so stages in one VPC cannot reach each other's database |
| database | `Postgres` 17 | in the VPC; the roles and schemas come from `grimoire db-setup`, the tables from `grimoire migrate` (under a database lock, so a second one waits); the connections use `sslmode=verify-full` against Amazon's database CA bundle, which the image fetches with a pinned checksum into `/app/certs`; the two role passwords are random and live in the state |
| files | `Bucket` with the CORS rule `files-setup` writes (`GET`, `PUT`, `HEAD` from the site; the rule belongs to the infrastructure: the task runs in `external` CORS mode, which means nothing in it writes the rule, and nothing checks it at start either, because only `grimoire files-setup` runs the check and the task does not run it; a drifted rule shows as failed browser uploads) | virtual addressing; the file origin in the policy names the bucket host |
| identity | the Descope project of the stage | the project id is the task's `GRIMOIRE_DESCOPE_PROJECT_ID`; the session token carries the person's profile (see "Tenants and the token"), so the server needs no Descope key |
| task | `db-setup`, then `migrate`, then `app` (`init-order.ts`) | the first two are not essential and the next container waits for each one's exit with 0 (ECS `dependsOn` with `SUCCESS`): a failing step stops the task before it serves, the old task keeps serving |
| task size and stop | 0.5 vCPU, 2 GB; the app has a 64 second stop timeout | the memory is above the collaboration memory guard (1 GiB by default) so the guard refuses work before the task is killed; 64 seconds is what the server needs to drain and save open pages (ECS's default of 30 would cut a deploy short; a test ties it to the server's budget) |
| secrets | Parameter Store `SecureString`, as ECS secrets | the database passwords and the three connection strings reach the containers by ARN, not as plain environment values; the `app` container gets only the runtime role's string, the schema owner's stays with `migrate` |
| file access | the task role, `GetObject`, `PutObject`, `DeleteObject`, `AbortMultipartUpload` and `ListMultipartUploadParts` on the bucket's objects and `ListBucket` on the bucket (a big upload goes to the bucket in parts: `PutObject` covers creating, uploading and completing one) | no access keys anywhere |
| unfinished uploads | a `BucketLifecycleConfiguration` of its own on the files bucket (`FilesLifecycle`), one rule `abort-incomplete-multipart`: an upload nobody finished or aborted is aborted 2 days after it began | the backstop; the component's `lifecycle` option is not used because it only expires objects and a second configuration of the bucket would overwrite this one |

Settings are variables of the stage's environment, named for no stage: `GRIMOIRE_DOMAIN`, `GRIMOIRE_ALLOWED_EMAIL_DOMAINS` (comma separated), and optionally `GRIMOIRE_FIRST_ADMIN_EMAILS` and `GRIMOIRE_REFUSED_EMAIL_DOMAINS`. They are the application's own setting names, which the stage passes on to the task. Run `diff` first.

Stated plainly: one task only (`scaling` is 1 to 1); the migration lock would make a second task wait, but staging needs no more. When Amazon publishes a new CA bundle, the image build fails at its checksum until the checksum in the `Dockerfile` is updated. The images are built three times from one Dockerfile (one for each container: SST names its build and its cache by container and has no way to share one, and the layers are the same, so the second and third builds are cache hits and push nothing new). Not run against a real account yet: the first `diff` and deploy are the proof of the load balancer rule, the container order, and the browser uploads against the bucket's rule.


## Tenants and the token

Two things in each project make the sign-in carry a tenant (the design is `docs/tenancy.md`):

- **The flow** `sign-up-or-in` (`descope/flows/sign-up-or-in.json`): after the one-time code is verified, a person who has a tenant goes on; otherwise `update-user-tenant-email-domain` joins them to the tenant whose self-provisioning domain is their email domain, and when there is none `createTenant` makes one named after the domain, with the domain as its self-provisioning domain, and selects it. Checked on a throwaway project with two test users of one domain (the first made the tenant, the second joined it).
- **The user token** (`JwtTemplate` `grimoire-user`, the project's user template): the automatic current-tenant claim `dct`, and the claims `email`, `name` and `emailVerified` (a boolean), next to the `tenants` map. The server already reads the profile claims, so it asks the provider for nothing and needs no management key. Checked on the same project.

The server does not use the tenant yet (`docs/tenancy.md` is a proposal); until it does, the sign-in of a project stays closed by `GRIMOIRE_ALLOWED_EMAIL_DOMAINS`, and the flow only creates tenants nobody reads.

A stage whose database held data before tenancy moves that `legacy` workspace into its real tenant once, by hand, with `grimoire tenant-adopt` as the migration role (`docs/operations/database-setup.md`); no task runs it.

## What it does not make

- Roles and permissions: the product authorizes with its own database. Tenants are made by the sign-in flow (below), not by code: the provider has no tenant resource.
- Passkeys, widgets and connectors: the sign-in does not use them (the built-in email delivery sends the code).
- Test users: the provider has only a static code for them, which is a secret. Create them through the management API when the live check needs one.
- The hand-made project "Grimoire dev" is not adopted. It stays as it is until the new development project works, and is then retired by the owner.

What the first deploy of the development stage showed: the company key made the project and its settings; the styles were refused because they named a components version (3.27.2) that was not the project's own (the project said 2.0.0), so the styles now name none (Descope applies them to the project's own version; an import without a version was accepted on a project made for the purpose, with the same `globals.colors`, `globals.fonts` and `globals.radius` keys). Whether the provider accepts the flow file as it is shows in the next deploy.

## No stored secret

The workflow `.github/workflows/descope-infra.yml` holds no secret. Its job runs in the environment of the stage it is given (each deploys from `main` only) with `id-token: write`, and asks GitHub for an OIDC token twice:

1. For AWS: `aws-actions/configure-aws-credentials` assumes the role in the variable `AWS_ROLE_ARN` (region in `AWS_REGION`). It is the shared `GithubActions` role (below).
2. For Descope: a token with the audience `https://api.descope.com/<key id>` (the variable `DESCOPE_MANAGEMENT_KEY_ID`) is used as `DESCOPE_MANAGEMENT_KEY`. The key is a *federated* management key with company scope and the role Full Management, because the stack creates projects: it holds no secret and trusts only the GitHub issuer, the subjects of the environments of the stages (`dev`, `staging`, and `production`, which the owner adds before the first production run: the plan's step 3), and a token lifetime of at most 15 minutes (so a run must finish within that). A company key can create and change every project of the company, not only ours: the projects made here are protected from deletion, and the key is used by these three environments only. The provider's own guide says the management key attribute accepts such a token.

**The subject is the immutable form.** This repository uses GitHub's immutable OIDC subject (a repository setting): the `sub` claim of a token carries the numeric ids of the organisation and the repository, `repo:tektum@271704328/grimoire@1466314324:environment:<environment>`, not their names. Both the AWS role's trust policy and the Descope key's allowed subject must use that form; the name form `repo:tektum/grimoire:environment:...` is refused (the first AWS run failed with `Not authorized to perform sts:AssumeRoleWithWebIdentity` until the trust was changed).

Until the three variables exist the job stops at its first step with a notice, and the workflow stays green.

## The AWS role

Every environment (`dev`, `production`, `staging`) assumes one existing role in the owner's account, `GithubActions`, which other repositories of the organisation already use and which has administrator access. Its trust policy lists one subject per environment (`repo:tektum@271704328/grimoire@1466314324:environment:dev`, `...:environment:staging`, and `...:environment:production`, which the owner adds before the first production run: `docs/operations/production-stage-plan.md`, step 2 for AWS), and every environment deploys from `main` only. The workflow reads the role from the variable `AWS_ROLE_ARN` and the region from `AWS_REGION` of the environment (variables, not secrets: neither is secret). SST is already bootstrapped in that account and region. The Descope job therefore has administrator access to the account. This repository holds no IAM tooling: the role and its trust policy are managed by the owner.

## The provider plugins

Provider plugins are binaries that run with the AWS role and the Descope token in their environment. Pulumi would download them on first use with no check, so the workflow installs every one first, before the job holds the AWS role or the Descope token, with Pulumi's own `plugin install --checksum`: it downloads the release archive, compares its sha256 with the value in `pulumi-plugins.txt`, and installs nothing on a mismatch. The run itself then sets `PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION`, so a plugin missing from the list stops the run, naming itself, instead of being downloaded unchecked. The list holds the Descope, AWS and random providers (their versions must equal `sst.config.ts`, a test checks) and the docker-build, command and tls providers SST 4.17.2 bundles. To update one, change its version and sha256 (of the linux-amd64 archive from the provider's GitHub release) together.

## Running it

- On a pull request that touches `sst.config.ts` or `infra/`: only `bun run check:infra` (installs the providers and typechecks the config). No credentials, no environment.
- By hand: Actions, "SST infrastructure", Run workflow on `main`, action `diff` (shows the difference, changes nothing) or `deploy`, for the stage `dev`, `production` or `staging`. Read the `diff` first.
- Locally with your own credentials: `bunx sst diff --stage dev` with AWS credentials, the `GRIMOIRE_*` variables of the stage in the environment, and `DESCOPE_MANAGEMENT_KEY` set to a management key of the development project only (never production, never committed).
