# Infrastructure (SST)

One [SST](https://sst.dev) app, `grimoire` (`sst.config.ts` at the repository root, the resources in this folder), with one file per stage:

| Stage | File | What it manages |
|---|---|---|
| `descope-dev` | `descope-dev.ts` | the sign-in settings of the existing development project "Grimoire dev": approved domains `127.0.0.1` and `localhost` (hosts only, no port: the web page on 4173 and the stack on 8080 are both covered), the app URL, and one-time code by email on |

No cloud resource belongs to `descope-dev`. SST keeps its state in the AWS account it is deployed to (its "home"), not in the repository, and does not need a state file. The Descope provider is `@descope/pulumi-descope` (Apache-2.0), which wraps the Descope Terraform provider.

## What it does not manage

- The project itself (it exists; only its settings are managed).
- The `sign-up-or-in` flow: the provider's `Flow` resource needs the flow's exported JSON, which only the console or the management API gives. It stays as it is in the project until that file is reviewed and committed.
- Passkeys, roles, tenants and widgets: the spec's sign-in does not use them.
- Test users: the provider only has a static code for test users, which is a secret. Create test users through the management API when the live check needs one.

## No stored secret

The workflow `.github/workflows/descope-infra.yml` holds no secret. Its job runs in the environment `descope-dev` (deploys from `main` only) with `id-token: write`, and asks GitHub for an OIDC token twice:

1. For AWS: `aws-actions/configure-aws-credentials` assumes the role in the variable `AWS_ROLE_ARN` (region in `AWS_REGION`). It is the shared `GithubActions` role (below).
2. For Descope: a token with the audience `https://api.descope.com/<key id>` (the variable `DESCOPE_MANAGEMENT_KEY_ID`) is used as `DESCOPE_MANAGEMENT_KEY`. The key is a *federated* management key: it holds no secret and trusts only the GitHub issuer, the subject `repo:tektum@271704328/grimoire@1466314324:environment:descope-dev`, and a token lifetime of at most 15 minutes (so a run must finish within that; ask again for a longer one). The provider's own guide says the management key attribute accepts such a token.

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
