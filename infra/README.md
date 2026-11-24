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

1. For AWS: `aws-actions/configure-aws-credentials` assumes the role in the variable `AWS_ROLE_ARN` (region in `AWS_REGION`). In the current setup that is the shared `GithubActions` role, which trusts the `descope-dev` and `staging` environments of this repository; with the recommended hardening it is a role that trusts only `repo:tektum/grimoire:environment:descope-dev`.
2. For Descope: a token with the audience `https://api.descope.com/<key id>` (the variable `DESCOPE_MANAGEMENT_KEY_ID`) is used as `DESCOPE_MANAGEMENT_KEY`. The key is a *federated* management key: it holds no secret and trusts only the GitHub issuer, the subject `repo:tektum/grimoire:environment:descope-dev`, and a token lifetime of at most 15 minutes (so a run must finish within that; ask again for a longer one). The provider's own guide says the management key attribute accepts such a token.

Until the three variables exist the job stops at its first step with a notice, and the workflow stays green.

## AWS roles: the current setup and the recommended hardening

**Current setup, by the owner's decision.** Both environments (`descope-dev`, `staging`) assume one existing role in the owner's account, `GithubActions`, which other repositories of the organisation already use and which has administrator access. Its trust policy lists the subjects `repo:tektum/grimoire:environment:descope-dev` and `repo:tektum/grimoire:environment:staging`, and both environments deploy from `main` only. The workflow reads the role from the variable `AWS_ROLE_ARN` and the region from `AWS_REGION` of the environment (variables, not secrets: neither is secret). SST is already bootstrapped in that account and region, so the administrator step below is done there. This setup gives the Descope job administrator access to the account: the least-privilege roles below are not in use.

**Recommended hardening, not applied.** Two separate roles, one per environment, each trusting only its own environment, with the Descope role limited to the keys of its own stage. The script, the exact policies and their tests are kept for that: switch by running the script and changing `AWS_ROLE_ARN` of each environment. The rest of this section describes that setup.

## One-time AWS set-up for the least-privilege roles (an administrator)

The deploy jobs need, in the AWS account, the GitHub OIDC provider and one role per environment. The script `infra/bootstrap/aws-github-oidc.sh` creates them and is safe to run again:

```sh
infra/bootstrap/aws-github-oidc.sh <account-id> <region> --print   # shows every document, calls nothing
infra/bootstrap/aws-github-oidc.sh <account-id> <region>           # needs the aws CLI and administrator credentials
```

It checks that the credentials belong to that account, creates the provider for `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`) if it is missing, then creates or updates two roles and prints their ARNs. Put each ARN in the variable `AWS_ROLE_ARN` of its GitHub environment (`descope-dev`, `staging`) and the region in `AWS_REGION`. The roles are separate on purpose: the Descope job can never create infrastructure, and its SSM access is limited to the `descope-dev` stage (its passphrase and secrets, and SST's shared bootstrap parameter), so it cannot read the staging passphrase or secrets. Both stages share one SST home, so the state bucket (`sst-state-*`) is one bucket, but SST keeps each stage's state under keys that name the stage (`app/grimoire/<stage>.json`, `lock/`, `secret/`, and `update/`, `summary/`, `eventlog/`, `snapshot/` folders; checked in SST's source at the pinned version), and the Descope role may read and write only the `descope-dev` keys. It can list the bucket (it sees the names of the stages) and cannot read or change the state or secrets of staging. The asset bucket (`sst-asset-*`) is shared and not scoped by stage: it holds build assets, which the Descope stage does not create.

| Role | Trusts only | Permissions |
|---|---|---|
| `grimoire-deploy-descope-dev` | `repo:tektum/grimoire:environment:descope-dev` | only the `descope-dev` stage's own state keys, passphrase and secrets, read access to SST's bootstrap parameter, and listing of the state bucket (below); it cannot create or change a bucket, its policy, or anything of another stage |
| `grimoire-deploy-staging` | `repo:tektum/grimoire:environment:staging` | SST's documented deploy policy, `infra/bootstrap/permissions-staging.json`, including its `Deployments` wildcard statement: narrow it once the staging stack exists |

Trust policy of each role (`ACCOUNT` is the 12-digit account id and `<environment>` is `descope-dev` or `staging`; the script fills both in; the file is `infra/bootstrap/trust.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:tektum/grimoire:environment:<environment>"
        }
      }
    }
  ]
}
```

Permissions of `grimoire-deploy-descope-dev` (`infra/bootstrap/permissions-descope-dev.json`; `ACCOUNT` and `REGION` are filled in by the script):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadBootstrap",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters"
      ],
      "Resource": [
        "arn:aws:ssm:REGION:ACCOUNT:parameter/sst/bootstrap"
      ]
    },
    {
      "Sid": "PassphraseOfThisStage",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter"
      ],
      "Resource": [
        "arn:aws:ssm:REGION:ACCOUNT:parameter/sst/passphrase/grimoire/descope-dev"
      ]
    },
    {
      "Sid": "ListStateBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketVersions"
      ],
      "Resource": [
        "arn:aws:s3:::sst-state-*"
      ]
    },
    {
      "Sid": "StateOfThisStageOnly",
      "Effect": "Allow",
      "Action": [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:GetObject",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::sst-state-*/app/grimoire/descope-dev.json",
        "arn:aws:s3:::sst-state-*/lock/grimoire/descope-dev.json",
        "arn:aws:s3:::sst-state-*/secret/grimoire/descope-dev.json",
        "arn:aws:s3:::sst-state-*/update/grimoire/descope-dev/*",
        "arn:aws:s3:::sst-state-*/summary/grimoire/descope-dev/*",
        "arn:aws:s3:::sst-state-*/eventlog/grimoire/descope-dev/*",
        "arn:aws:s3:::sst-state-*/snapshot/grimoire/descope-dev/*"
      ]
    },
    {
      "Sid": "ManageSecrets",
      "Effect": "Allow",
      "Action": [
        "ssm:DeleteParameter",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:PutParameter",
        "ssm:AddTagsToResource",
        "ssm:ListTagsForResource"
      ],
      "Resource": [
        "arn:aws:ssm:REGION:ACCOUNT:parameter/sst/grimoire/descope-dev/*"
      ]
    }
  ]
}
```

Then, once per account and region, an administrator bootstraps SST with their own credentials, from a checkout of this repository: `bunx sst install`, then `AWS_REGION=<region> bunx sst diff --stage descope-dev`. SST bootstraps the account on its first command that uses the home. With no Descope key set the command then stops at the Descope provider with an authentication error: that is expected, nothing in Descope is touched (this step has not been run on a real account, so check that `/sst/bootstrap` exists afterwards: `aws ssm get-parameter --name /sst/bootstrap --region <region>`).

A run of the script is tested with `--print` only (`tools/ci/test/aws-bootstrap.test.mjs`): it checks the documents are valid JSON, each role trusts exactly its own environment, and the Descope role has no wildcard statement. Applying them needs a real account and has not been run.

## The provider plugin

The Descope plugin is a binary that runs with the Descope token in its environment. Pulumi would download it on first use with no checksum, so the workflow installs it first, before the job holds the AWS role or the Descope token: `infra/install-provider.sh` downloads the release asset named in `infra/provider-checksums.txt`, checks its sha256 (a mismatch installs nothing), and gives it to Pulumi with `plugin install --reinstall --file`, into SST's own Pulumi home (`~/.config/sst`, where SST looks for plugins; a copy fetched without a check is replaced). To update the provider: change the version in `sst.config.ts`, download the new `linux-amd64` asset, and put its sha256 and file name in the checksums file (`tools/ci/test/provider-checksums.test.mjs` fails if the two disagree). The official Pulumi AWS plugin is still downloaded by SST on demand and is not pinned; it runs in the same job and inherits the Descope token in its environment. Pinning it the same way is not done.

## Running it

- On a pull request that touches `sst.config.ts` or `infra/`: only `bun run check:infra` (installs the providers and typechecks the config). No credentials, no environment.
- By hand: Actions, "SST infrastructure", Run workflow on `main`, action `diff` (shows the difference, changes nothing) or `deploy`. Read the `diff` first.
- Locally with your own credentials: `bunx sst diff --stage descope-dev` with AWS credentials in the environment and `DESCOPE_MANAGEMENT_KEY` set to a management key of the development project only (never production, never committed).

SST needs a home (a state bucket, an asset bucket, a container repository and the `/sst/bootstrap` parameter) in the account and region before any run. The Descope role cannot create it, and cannot change a bucket policy (which could grant it access to the state of another stage), so an administrator bootstraps once, below.
