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

1. For AWS: `aws-actions/configure-aws-credentials` assumes the role in the variable `AWS_ROLE_ARN` (region in `AWS_REGION`). The role trusts only `repo:tektum/grimoire:environment:descope-dev`.
2. For Descope: a token with the audience `https://api.descope.com/<key id>` (the variable `DESCOPE_MANAGEMENT_KEY_ID`) is used as `DESCOPE_MANAGEMENT_KEY`. The key is a *federated* management key: it holds no secret and trusts only the GitHub issuer, the subject `repo:tektum/grimoire:environment:descope-dev`, and a token lifetime of at most 15 minutes (so a run must finish within that; ask again for a longer one). The provider's own guide says the management key attribute accepts such a token.

Until the three variables exist the job stops at its first step with a notice, and the workflow stays green.

## Running it

- On a pull request that touches `sst.config.ts` or `infra/`: only `bun run check:infra` (installs the providers and typechecks the config). No credentials, no environment.
- By hand: Actions, "SST infrastructure", Run workflow on `main`, action `diff` (shows the difference, changes nothing) or `deploy`. Read the `diff` first.
- Locally with your own credentials: `bunx sst diff --stage descope-dev` with AWS credentials in the environment and `DESCOPE_MANAGEMENT_KEY` set to a management key of the development project only (never production, never committed).

SST creates its home in the AWS account and region on the first run (a state bucket and `/sst/*` parameters), so the role needs the permissions of [SST's IAM guide](https://sst.dev/docs/iam-credentials) for that, and nothing broader: this stage creates no AWS resource.
