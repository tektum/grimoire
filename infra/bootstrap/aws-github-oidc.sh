#!/usr/bin/env bash
# One-time AWS set-up for the GitHub deploy jobs (run by an AWS administrator, safe to run again):
#   1. the GitHub OIDC identity provider of the account,
#   2. the role grimoire-deploy-descope-dev (trusts only the environment descope-dev; SST bootstrap permissions only),
#   3. the role grimoire-deploy-staging (trusts only the environment staging; the full SST deploy policy).
# Usage: infra/bootstrap/aws-github-oidc.sh <account-id> <region>        (needs the aws CLI and administrator credentials)
#        infra/bootstrap/aws-github-oidc.sh <account-id> <region> --print  (prints what it would create, calls nothing)
# It prints the two role ARNs. Put each in the variable AWS_ROLE_ARN of its GitHub environment, and the region in AWS_REGION.
set -eu

account="${1:?usage: aws-github-oidc.sh <account-id> <region> [--print]}"
region="${2:?usage: aws-github-oidc.sh <account-id> <region> [--print]}"
mode="${3:-apply}"
case "$mode" in apply|--print) ;; *) echo "unknown option: $mode (only --print)" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"
issuer="token.actions.githubusercontent.com"

case "$account" in *[!0-9]*|'') echo "account-id must be 12 digits" >&2; exit 2;; esac
[ "${#account}" -eq 12 ] || { echo "account-id must be 12 digits" >&2; exit 2; }
case "$region" in [a-z][a-z]-*-[0-9]*) ;; *) echo "region looks wrong: $region" >&2; exit 2;; esac

render() { sed -e "s/__ACCOUNT__/$account/g" -e "s/__REGION__/$region/g" -e "s/__ENVIRONMENT__/${2:-}/g" "$here/$1"; }

if [ "$mode" = "--print" ]; then
  for pair in "descope-dev:permissions-descope-dev.json" "staging:permissions-staging.json"; do
    environment="${pair%%:*}"
    echo "== role grimoire-deploy-$environment: trust policy"
    render trust.json "$environment"
    echo "== role grimoire-deploy-$environment: permissions"
    render "${pair#*:}" "$environment"
  done
  exit 0
fi

actual="$(aws sts get-caller-identity --query Account --output text)"
[ "$actual" = "$account" ] || { echo "the credentials are for account $actual, not $account" >&2; exit 2; }

provider="arn:aws:iam::$account:oidc-provider/$issuer"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider" >/dev/null 2>&1; then
  echo "OIDC provider exists: $provider"
else
  # AWS ignores the thumbprint for this issuer (it trusts its own CA store); the call still wants one value.
  aws iam create-open-id-connect-provider --url "https://$issuer" --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
  echo "OIDC provider created: $provider"
fi

for pair in "descope-dev:permissions-descope-dev.json" "staging:permissions-staging.json"; do
  environment="${pair%%:*}"
  role="grimoire-deploy-$environment"
  trust="$(render trust.json "$environment")"
  if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    aws iam update-assume-role-policy --role-name "$role" --policy-document "$trust"
    echo "role updated: $role"
  else
    aws iam create-role --role-name "$role" --assume-role-policy-document "$trust" --max-session-duration 3600 \
      --description "GitHub Actions deploy role of tektum/grimoire, environment $environment" >/dev/null
    echo "role created: $role"
  fi
  aws iam put-role-policy --role-name "$role" --policy-name sst-deploy --policy-document "$(render "${pair#*:}" "$environment")"
  echo "arn:aws:iam::$account:role/$role"
done
