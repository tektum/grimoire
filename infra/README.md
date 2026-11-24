# Infrastructure (SST)

One [SST](https://sst.dev) app, `grimoire` (`sst.config.ts` at the repository root, the resources in this folder), one stage for each environment. SST keeps its state in the AWS account it is deployed to (its "home"), not in the repository. The Descope provider is `@descope/pulumi-descope` (Apache-2.0), which wraps the Descope Terraform provider.

| Stage | File | What it makes |
|---|---|---|
| `descope-dev` | `descope-dev.ts` | the Descope project "Grimoire development", for local runs |
| `staging` | (hosting, with its own Descope project "Grimoire staging") | the next change |

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

## The provider plugin

The Descope plugin is a binary that runs with the Descope token in its environment. Pulumi would download it on first use with no check, so the workflow installs it first, before the job holds the AWS role or the Descope token, with Pulumi's own `plugin install --checksum`: it downloads the release asset, compares its sha256 with the value in the workflow, and installs nothing on a mismatch (shown by hand). It installs into SST's own Pulumi home (`~/.config/sst`, where SST looks for plugins) with `--reinstall`, which replaces a copy that is already there. To update the provider, change the version in `sst.config.ts` and the version and sha256 in the workflow (`tools/ci/test/provider-pin.test.mjs` fails if the versions disagree). The official Pulumi AWS plugin is still downloaded by SST on demand and is not pinned; it runs in the same job and inherits the Descope token in its environment.

## Running it

- On a pull request that touches `sst.config.ts` or `infra/`: only `bun run check:infra` (installs the providers and typechecks the config). No credentials, no environment.
- By hand: Actions, "SST infrastructure", Run workflow on `main`, action `diff` (shows the difference, changes nothing) or `deploy`. Read the `diff` first.
- Locally with your own credentials: `bunx sst diff --stage descope-dev` with AWS credentials in the environment and `DESCOPE_MANAGEMENT_KEY` set to a management key of the development project only (never production, never committed).
