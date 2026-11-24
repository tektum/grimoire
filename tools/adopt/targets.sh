#!/usr/bin/env bash
# The one database and the one cluster of a stage, by their exact names (what SST makes: `grimoire-<stage>-dbinstance-<id>` and `grimoire-<stage>-ClusterCluster-<id>`), and the proof
# that they are in the same network: the snapshot and the adoption task both take what this prints, so the restore point is that of the database the task changes.
# Retained resources of a replaced stage keep their prefix, so a substring match could pick another: more than one match, or none, stops with what was found.
# Prints `instance=<id>` and `cluster=<arn>`. Needs `aws` and `jq`; run with the stage's credentials.
set -euo pipefail
stage="${1:-}"
[[ "${stage}" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "usage: targets.sh <stage>" >&2; exit 2; }

one() { # <what> <json list of matches>
  [ "$(jq length <<<"$2")" = "1" ] || { echo "expected one $1 of the stage ${stage}, found: $2" >&2; exit 1; }
  jq -r '.[0]' <<<"$2"
}

databases=$(aws rds describe-db-instances --output json)
instance=$(one database "$(jq -c --arg re "^grimoire-${stage}-dbinstance-[a-z0-9]+\$" '[.DBInstances[].DBInstanceIdentifier | select(test($re))]' <<<"${databases}")")
db_vpc=$(jq -r --arg id "${instance}" '.DBInstances[] | select(.DBInstanceIdentifier == $id) | .DBSubnetGroup.VpcId' <<<"${databases}")

clusters=$(aws ecs list-clusters --output json)
cluster=$(one cluster "$(jq -c --arg re "^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]+:cluster/grimoire-${stage}-ClusterCluster-[a-z0-9]+\$" '[.clusterArns[] | select(test($re))]' <<<"${clusters}")")

subnet=$(aws ecs describe-services --cluster "${cluster}" --services Server --output json | jq -r '.services[0].networkConfiguration.awsvpcConfiguration.subnets[0] // empty')
[ -n "${subnet}" ] || { echo "the service of the stage ${stage} has no subnet" >&2; exit 1; }
service_vpc=$(aws ec2 describe-subnets --subnet-ids "${subnet}" --output json | jq -r '.Subnets[0].VpcId')
[ "${db_vpc}" = "${service_vpc}" ] || { echo "the database ${instance} is not in the network of the service (${db_vpc} against ${service_vpc})" >&2; exit 1; }

echo "instance=${instance}"
echo "cluster=${cluster}"
