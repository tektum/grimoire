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

## One-time AWS set-up (an administrator)

The deploy jobs need, in the AWS account, the GitHub OIDC provider and one role per environment. The script `infra/bootstrap/aws-github-oidc.sh` creates them and is safe to run again:

```sh
infra/bootstrap/aws-github-oidc.sh <account-id> <region> --print   # shows every document, calls nothing
infra/bootstrap/aws-github-oidc.sh <account-id> <region>           # needs the aws CLI and administrator credentials
```

It checks that the credentials belong to that account, creates the provider for `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`) if it is missing, then creates or updates two roles and prints their ARNs. Put each ARN in the variable `AWS_ROLE_ARN` of its GitHub environment (`descope-dev`, `staging`) and the region in `AWS_REGION`. The roles are separate on purpose: the Descope job can never create infrastructure.

| Role | Trusts only | Permissions |
|---|---|---|
| `grimoire-deploy-descope-dev` | `repo:tektum/grimoire:environment:descope-dev` | SST's bootstrap and secrets statements, nothing else (below) |
| `grimoire-deploy-staging` | `repo:tektum/grimoire:environment:staging` | SST's documented deploy policy, `infra/bootstrap/permissions-staging.json`, including its `Deployments` wildcard statement: narrow it once the staging stack exists |

Trust policy of each role (`<environment>` is `descope-dev` or `staging`; the file is `infra/bootstrap/trust.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::__ACCOUNT__:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:tektum/grimoire:environment:__ENVIRONMENT__"
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
      "Sid": "ManageBootstrapStateBucket",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketVersioning",
        "s3:PutBucketNotification",
        "s3:PutBucketPolicy",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::sst-state-*"
      ]
    },
    {
      "Sid": "ManageBootstrapAssetBucket",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketVersioning",
        "s3:PutBucketNotification",
        "s3:PutBucketPolicy",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:ListBucket",
        "s3:PutObject"
      ],
      "Resource": [
        "arn:aws:s3:::sst-asset-*"
      ]
    },
    {
      "Sid": "ManageBootstrapECRRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:CreateRepository",
        "ecr:DescribeRepositories"
      ],
      "Resource": [
        "arn:aws:ecr:REGION:ACCOUNT:repository/sst-asset"
      ]
    },
    {
      "Sid": "ManageBootstrapSSMParameter",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameters",
        "ssm:PutParameter"
      ],
      "Resource": [
        "arn:aws:ssm:REGION:ACCOUNT:parameter/sst/passphrase/*",
        "arn:aws:ssm:REGION:ACCOUNT:parameter/sst/bootstrap"
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
        "arn:aws:ssm:REGION:ACCOUNT:parameter/sst/*"
      ]
    }
  ]
}
```

A run of the script is tested with `--print` only (`tools/ci/test/aws-bootstrap.test.mjs`): it checks the documents are valid JSON, each role trusts exactly its own environment, and the Descope role has no wildcard statement. Applying them needs a real account and has not been run.

## Running it

- On a pull request that touches `sst.config.ts` or `infra/`: only `bun run check:infra` (installs the providers and typechecks the config). No credentials, no environment.
- By hand: Actions, "SST infrastructure", Run workflow on `main`, action `diff` (shows the difference, changes nothing) or `deploy`. Read the `diff` first.
- Locally with your own credentials: `bunx sst diff --stage descope-dev` with AWS credentials in the environment and `DESCOPE_MANAGEMENT_KEY` set to a management key of the development project only (never production, never committed).

SST creates its home in the AWS account and region on the first run (a state bucket and `/sst/*` parameters), so the role needs the permissions of [SST's IAM guide](https://sst.dev/docs/iam-credentials) for that, and nothing broader: this stage creates no AWS resource.
