#!/usr/bin/env bash
# A snapshot of the database of a stage, waited for until it can be restored from. An RDS instance and an Aurora cluster are snapshotted by different calls and waited for by different
# waiters, so the kind (`database_kind` of targets.sh) says which. Usage: snapshot.sh instance|cluster <id> <snapshot name>. Needs `aws`; run with the stage's credentials.
set -euo pipefail
kind="${1:-}"
id="${2:-}"
snapshot="${3:-}"
usage() { echo "usage: snapshot.sh instance|cluster <id> <snapshot name>" >&2; exit 2; }
[[ "${kind}" =~ ^(instance|cluster)$ ]] || usage
[ -n "${id}" ] || usage
[[ "${snapshot}" =~ ^[A-Za-z][A-Za-z0-9-]{0,254}$ ]] || usage

if [ "${kind}" = "instance" ]; then
  aws rds create-db-snapshot --db-instance-identifier "${id}" --db-snapshot-identifier "${snapshot}" --query 'DBSnapshot.Status' --output text
  aws rds wait db-snapshot-available --db-snapshot-identifier "${snapshot}"
else
  aws rds create-db-cluster-snapshot --db-cluster-identifier "${id}" --db-cluster-snapshot-identifier "${snapshot}" --query 'DBClusterSnapshot.Status' --output text
  aws rds wait db-cluster-snapshot-available --db-cluster-snapshot-identifier "${snapshot}"
fi
echo "snapshot ${snapshot} of ${kind} ${id} is available: it is what a restore of this stage's data starts from"
