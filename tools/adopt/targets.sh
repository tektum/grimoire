#!/usr/bin/env bash
# The one database and the one cluster of a stage, by what SST makes, and the proof that they are in the same network: the snapshot and the adoption task both take what this prints, so the
# restore point is that of the database the task changes. The database is an RDS instance (`grimoire-<stage>-dbinstance-<id>`, found by its exact name) or an Aurora PostgreSQL cluster (found by the
# tags SST puts on what it makes, `sst:app` and `sst:stage`, so that no naming rule of SST is assumed); the cluster is the ECS cluster (`grimoire-<stage>-ClusterCluster-<id>`).
# Retained resources of a replaced stage keep their prefix, so a substring match could pick another: more than one match, or none, stops with what was found. While a stage holds both an
# instance and a cluster (the overlap of a move between them) the kind has to be named: `targets.sh <stage> instance|cluster`.
# Prints `database=<id>`, `database_kind=instance|cluster` and `cluster=<arn>`. Needs `aws` and `jq`; run with the stage's credentials.
set -euo pipefail
stage="${1:-}"
kind="${2:-}"
[[ "${stage}" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "usage: targets.sh <stage> [instance|cluster]" >&2; exit 2; }
[[ "${kind}" =~ ^(instance|cluster)?$ ]] || { echo "usage: targets.sh <stage> [instance|cluster]" >&2; exit 2; }

one() { # <what> <json list of matches>
  [ "$(jq length <<<"$2")" = "1" ] || { echo "expected one $1 of the stage ${stage}, found: $2" >&2; exit 1; }
  jq -r '.[0]' <<<"$2"
}

instances=$(aws rds describe-db-instances --output json)
aurora=$(aws rds describe-db-clusters --output json)
candidates=$(jq -nc --arg re "^grimoire-${stage}-dbinstance-[a-z0-9]+\$" --arg stage "${stage}" --arg kind "${kind}" --argjson i "${instances}" --argjson c "${aurora}" '
  def tagged($k; $v): [.TagList[]? | select(.Key == $k and .Value == $v)] | length > 0;
  ([$i.DBInstances[] | select(.DBInstanceIdentifier | test($re)) | {kind: "instance", id: .DBInstanceIdentifier, vpc: .DBSubnetGroup.VpcId}]
   + [$c.DBClusters[] | select(.Engine == "aurora-postgresql" and tagged("sst:app"; "grimoire") and tagged("sst:stage"; $stage)) | {kind: "cluster", id: .DBClusterIdentifier, subnetGroup: .DBSubnetGroup}])
  | map(select($kind == "" or .kind == $kind))')
what=$([ -n "${kind}" ] && echo "${kind}" || echo database)
chosen=$(one "${what}" "$(jq -c '[.[] | "\(.kind):\(.id)"]' <<<"${candidates}")")
database_kind="${chosen%%:*}"
database="${chosen#*:}"
if [ "${database_kind}" = "instance" ]; then
  db_vpc=$(jq -r --arg id "${database}" '.[] | select(.id == $id) | .vpc' <<<"${candidates}")
else
  subnet_group=$(jq -r --arg id "${database}" '.[] | select(.id == $id) | .subnetGroup' <<<"${candidates}")
  db_vpc=$(aws rds describe-db-subnet-groups --db-subnet-group-name "${subnet_group}" --output json | jq -r '.DBSubnetGroups[0].VpcId')
fi

clusters=$(aws ecs list-clusters --output json)
cluster=$(one cluster "$(jq -c --arg re "^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]+:cluster/grimoire-${stage}-ClusterCluster-[a-z0-9]+\$" '[.clusterArns[] | select(test($re))]' <<<"${clusters}")")

subnet=$(aws ecs describe-services --cluster "${cluster}" --services Server --output json | jq -r '.services[0].networkConfiguration.awsvpcConfiguration.subnets[0] // empty')
[ -n "${subnet}" ] || { echo "the service of the stage ${stage} has no subnet" >&2; exit 1; }
service_vpc=$(aws ec2 describe-subnets --subnet-ids "${subnet}" --output json | jq -r '.Subnets[0].VpcId')
[ "${db_vpc}" = "${service_vpc}" ] || { echo "the database ${database} is not in the network of the service (${db_vpc} against ${service_vpc})" >&2; exit 1; }

echo "database=${database}"
echo "database_kind=${database_kind}"
echo "cluster=${cluster}"
