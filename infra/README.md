# Infrastructure (SST)

One [SST](https://sst.dev) app, `grimoire` (`sst.config.ts` at the repository root, the resources in this folder), one stage for each environment. SST keeps its state in the AWS account it is deployed to (its "home"), not in the repository. The Descope provider is `@descope/pulumi-descope` (Apache-2.0), which wraps the Descope Terraform provider.

| Stage | File | What it makes |
|---|---|---|
| `descope-dev` | `descope-dev.ts` | the Descope project "Grimoire development", for local runs |
| `staging` | `staging.ts` | the hosted staging site (below) and its own Descope project "Grimoire staging" |

## One Descope project for each stage, all of it code

`descope/project.ts` creates the project of a stage and everything in it; nothing is edited in the console. `descope/config.ts` holds what a stage is made of as plain data (tested), and `descope/theme.ts` makes the styles from the web client's design tokens (`apps/web/src/ui/tokens.css`: accent, paper, ink, fonts and radius, light and dark), so a change to the tokens changes the sign-in screens at the next deploy.

| In the project | Resource | Setting |
|---|---|---|
| the project | `Project` | named for the stage, protected from deletion, no `environment` (it is set to `production` for a production project) |
| address | `ProjectSettings` | app URL and approved domains: `http://127.0.0.1:4173` with `127.0.0.1` and `localhost` for development, `https://<STAGING_DOMAIN>` for staging (hosts only; the provider takes no port) |
| sign-in | `OtpSettings` and the flow `sign-up-or-in` (`descope/flows/sign-up-or-in.json`) | a one-time code by email, and nothing else |
| other methods | password, magic link, enchanted link, embedded link, TOTP, passkeys, OAuth | all off |
| sessions | `SessionSettings` | session token 10 minutes (the server accepts up to a day), refresh token 3 weeks, rotating |
| look | `Styles` | the design tokens |

The flow is the Descope template "Sign up or in - OTP or sniper email link" (one-time code by email, with a shortcut to the reader's mail inbox), checked with the management API's `ValidateFlow` and kept as a file so a change to it is a pull request. The id of each stage's project is the stack's output (and an SST link), so the application takes it from there, not from a variable set by hand.

## The staging site (`staging.ts`)

One Fargate task (the image of the `Dockerfile`, which serves the web client and the API on port 8080) behind an HTTPS load balancer at `STAGING_DOMAIN`, with the Route 53 zone of that domain looked up (never made), a certificate validated through it, and an HTTP to HTTPS redirect. The load balancer checks `/readyz`.

| Part | Resource | Notes |
|---|---|---|
| network | `Vpc` | private subnets, one NAT instance (cheaper than the managed gateway) |
| database | `Postgres` 17 | in the VPC; the roles and schemas come from `grimoire db-setup`, the tables from `grimoire migrate` (under a database lock, so a second one waits); the connections use `sslmode=verify-full` against Amazon's database CA bundle, which the image fetches with a pinned checksum into `/app/certs`; the two role passwords are random and live in the state |
| files | `Bucket` with the CORS rule `files-setup` writes (`GET`, `PUT`, `HEAD` from the site; the server runs in `external` CORS mode, so it checks the rule and never writes it) | virtual addressing; the file origin in the policy names the bucket host |
| identity | the Descope project of the stage | the project id is the task's `GRIMOIRE_DESCOPE_PROJECT_ID` |
| task | `db-setup`, then `migrate`, then `app` (`init-order.ts`) | the first two are not essential and the next container waits for each one's exit with 0 (ECS `dependsOn` with `SUCCESS`): a failing step stops the task before it serves, the old task keeps serving |
| task size and stop | 0.5 vCPU, 2 GB; the app has a 64 second stop timeout | the memory is above the collaboration memory guard (1 GiB by default) so the guard refuses work before the task is killed; 64 seconds is what the server needs to drain and save open pages (ECS's default of 30 would cut a deploy short; a test ties it to the server's budget) |
| secrets | Parameter Store `SecureString`, as ECS secrets | the database passwords and the three connection strings reach the containers by ARN, not as plain environment values; the `app` container gets only the runtime role's string, the schema owner's stays with `migrate` |
| file access | the task role, `GetObject`, `PutObject` and `DeleteObject` on the bucket's objects and `ListBucket` on the bucket | no access keys anywhere |

Settings are variables of the environment `staging`: `STAGING_DOMAIN`, `STAGING_ALLOWED_EMAIL_DOMAINS` (comma separated) and `STAGING_FIRST_ADMIN_EMAILS` (optional). Run `diff` for `staging` first.

Stated plainly: one task only (`scaling` is 1 to 1); the migration lock would make a second task wait, but staging needs no more. When Amazon publishes a new CA bundle, the image build fails at its checksum until the checksum in the `Dockerfile` is updated. The images are built three times from one Dockerfile (one for each container: SST names its build and its cache by container and has no way to share one, and the layers are the same, so the second and third builds are cache hits and push nothing new). Not run against a real account yet: the first `diff` and deploy are the proof of the load balancer rule, the container order, and the file store check at start.

## What it does not make

- Roles, permissions and tenants: the product authorizes with its own database, and the provider has no tenant resource (only a tenant attribute).
- Passkeys, widgets and connectors: the sign-in does not use them (the built-in email delivery sends the code).
- Test users: the provider has only a static code for them, which is a secret. Create them through the management API when the live check needs one.
- The hand-made project "Grimoire dev" is not adopted. It stays as it is until the new development project works, and is then retired by the owner.

Not checked against a real project yet, stated plainly: the styles JSON (the keys `globals.colors`, `globals.fonts`, `globals.radius` follow Descope's code-mode reference, and the provider's own test data uses a `designTokens` form), and whether the provider accepts the flow file as it is. The first `diff` after the company key exists shows the plan, and the first deploy to the development stage is the proof.

## No stored secret

The workflow `.github/workflows/descope-infra.yml` holds no secret. Its job runs in the environment `descope-dev` (deploys from `main` only) with `id-token: write`, and asks GitHub for an OIDC token twice:

1. For AWS: `aws-actions/configure-aws-credentials` assumes the role in the variable `AWS_ROLE_ARN` (region in `AWS_REGION`). It is the shared `GithubActions` role (below).
2. For Descope: a token with the audience `https://api.descope.com/<key id>` (the variable `DESCOPE_MANAGEMENT_KEY_ID`) is used as `DESCOPE_MANAGEMENT_KEY`. The key is a *federated* management key with company scope and the role Full Management, because the stack creates projects: it holds no secret and trusts only the GitHub issuer, the subjects of the two environments (`descope-dev` and `staging`), and a token lifetime of at most 15 minutes (so a run must finish within that). A company key can create and change every project of the company, not only ours: the projects made here are protected from deletion, and the key is used by these two environments only. The provider's own guide says the management key attribute accepts such a token.

**The subject is the immutable form.** This repository uses GitHub's immutable OIDC subject (a repository setting): the `sub` claim of a token carries the numeric ids of the organisation and the repository, `repo:tektum@271704328/grimoire@1466314324:environment:<environment>`, not their names. Both the AWS role's trust policy and the Descope key's allowed subject must use that form; the name form `repo:tektum/grimoire:environment:...` is refused (the first AWS run failed with `Not authorized to perform sts:AssumeRoleWithWebIdentity` until the trust was changed).

Until the three variables exist the job stops at its first step with a notice, and the workflow stays green.

## The AWS role

Both environments (`descope-dev`, `staging`) assume one existing role in the owner's account, `GithubActions`, which other repositories of the organisation already use and which has administrator access. Its trust policy lists the subjects `repo:tektum@271704328/grimoire@1466314324:environment:descope-dev` and `repo:tektum@271704328/grimoire@1466314324:environment:staging`, and both environments deploy from `main` only. The workflow reads the role from the variable `AWS_ROLE_ARN` and the region from `AWS_REGION` of the environment (variables, not secrets: neither is secret). SST is already bootstrapped in that account and region. The Descope job therefore has administrator access to the account. This repository holds no IAM tooling: the role and its trust policy are managed by the owner.

## The provider plugins

Provider plugins are binaries that run with the AWS role and the Descope token in their environment. Pulumi would download them on first use with no check, so the workflow installs every one first, before the job holds the AWS role or the Descope token, with Pulumi's own `plugin install --checksum`: it downloads the release archive, compares its sha256 with the value in `pulumi-plugins.txt`, and installs nothing on a mismatch. The run itself then sets `PULUMI_DISABLE_AUTOMATIC_PLUGIN_ACQUISITION`, so a plugin missing from the list stops the run, naming itself, instead of being downloaded unchecked. The list holds the Descope, AWS and random providers (their versions must equal `sst.config.ts`, a test checks) and the docker-build, command and tls providers SST 4.17.2 bundles. To update one, change its version and sha256 (of the linux-amd64 archive from the provider's GitHub release) together.

## Running it

- On a pull request that touches `sst.config.ts` or `infra/`: only `bun run check:infra` (installs the providers and typechecks the config). No credentials, no environment.
- By hand: Actions, "SST infrastructure", Run workflow on `main`, action `diff` (shows the difference, changes nothing) or `deploy`, for the stage `descope-dev` or `staging`. Read the `diff` first.
- Locally with your own credentials: `bunx sst diff --stage descope-dev` with AWS credentials in the environment and `DESCOPE_MANAGEMENT_KEY` set to a management key of the development project only (never production, never committed).
