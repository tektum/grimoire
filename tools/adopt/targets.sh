#!/usr/bin/env bash
# The one database and the one cluster of a stage, and the proof that they are in the same network: the snapshot and the adoption task both take what this prints, so the restore point is that of the
# database the task changes. The database is the one the service connects to: its migration container holds a connection string (an SSM SecureString), and the database of the stage whose
# endpoint is that string's host is the one. So while a stage has two databases (an RDS instance and an Aurora cluster during a move, or a retained one of a replaced stage) the task and the
# snapshot still agree. The candidates are the stage's instances (`grimoire-<stage>-dbinstance-<id>`, by exact name) and Aurora PostgreSQL clusters (by the `sst:app` and `sst:stage` tags SST puts
# on what it makes, so that no naming rule of SST is assumed); the cluster is the ECS cluster (`grimoire-<stage>-ClusterCluster-<id>`). More than one match, or none, stops with what was found.
# The connection string is read for its host and never printed. Prints `database=<id>`, `database_kind=instance|cluster` and `cluster=<arn>`. Needs `aws` and `jq`; run with the stage's credentials.
set -euo pipefail
stage="${1:-}"
[ "$#" -le 1 ] && [[ "${stage}" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "usage: targets.sh <stage>" >&2; exit 2; }

one() { # <what> <json list of matches>
  [ "$(jq length <<<"$2")" = "1" ] || { echo "expected one $1 of the stage ${stage}, found: $2" >&2; exit 1; }
  jq -r '.[0]' <<<"$2"
}

instances=$(aws rds describe-db-instances --output json)
aurora=$(aws rds describe-db-clusters --output json)
# Through a pipe, not as arguments: one argument may hold 128 KiB, and the answers of an account with many databases hold more.
candidates=$(printf '%s\n%s\n' "${instances}" "${aurora}" | jq -sc --arg re "^grimoire-${stage}-dbinstance-[a-z0-9]+\$" --arg stage "${stage}" '
  def tagged($k; $v): [.TagList[]? | select(.Key == $k and .Value == $v)] | length > 0;
  .[0] as $i | .[1] as $c
  | [$i.DBInstances[] | select(.DBInstanceIdentifier | test($re)) | {kind: "instance", id: .DBInstanceIdentifier, endpoint: .Endpoint.Address, vpc: .DBSubnetGroup.VpcId}]
  + [$c.DBClusters[] | select(.Engine == "aurora-postgresql" and tagged("sst:app"; "grimoire") and tagged("sst:stage"; $stage)) | {kind: "cluster", id: .DBClusterIdentifier, endpoint: .Endpoint, subnetGroup: .DBSubnetGroup}]')

clusters=$(aws ecs list-clusters --output json)
cluster=$(one cluster "$(jq -c --arg re "^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]+:cluster/grimoire-${stage}-ClusterCluster-[a-z0-9]+\$" '[.clusterArns[] | select(test($re))]' <<<"${clusters}")")

service=$(aws ecs describe-services --cluster "${cluster}" --services Server --output json)
subnet=$(jq -r '.services[0].networkConfiguration.awsvpcConfiguration.subnets[0] // empty' <<<"${service}")
[ -n "${subnet}" ] || { echo "the service of the stage ${stage} has no subnet" >&2; exit 1; }

# The host the migration container connects to.
taskdef=$(jq -r '.services[0].taskDefinition // empty' <<<"${service}")
secret=$(aws ecs describe-task-definition --task-definition "${taskdef}" --output json | jq -r '[.taskDefinition.containerDefinitions[] | select(.name == "migrate") | .secrets[]? | select(.name == "GRIMOIRE_DATABASE_MIGRATION_URL") | .valueFrom] | .[0] // empty')
[ -n "${secret}" ] || { echo "the migration container of the service of the stage ${stage} has no GRIMOIRE_DATABASE_MIGRATION_URL" >&2; exit 1; }
case "${secret}" in arn:*:parameter*) parameter="${secret#*:parameter}" ;; *) parameter="${secret}" ;; esac
connection=$(aws ssm get-parameter --name "${parameter}" --with-decryption --query Parameter.Value --output text)
rest="${connection#*@}"
live_host="${rest%%[:/?]*}"
{ [ "${rest}" != "${connection}" ] && [[ "${live_host}" =~ ^[A-Za-z0-9.-]+$ ]]; } || { echo "the connection string of the migration container of the stage ${stage} has no host" >&2; exit 1; }
unset connection rest

matches=$(jq -c --arg h "${live_host}" '[.[] | select(.endpoint == $h)]' <<<"${candidates}")
[ "$(jq length <<<"${matches}")" = "1" ] || { echo "expected one database of the stage ${stage} that the service connects to (${live_host}), found: $(jq -c '[.[] | "\(.kind):\(.id)"]' <<<"${matches}")" >&2; exit 1; }
database_kind=$(jq -r '.[0].kind' <<<"${matches}")
database=$(jq -r '.[0].id' <<<"${matches}")
if [ "${database_kind}" = "instance" ]; then
  db_vpc=$(jq -r '.[0].vpc' <<<"${matches}")
else
  subnet_group=$(jq -r '.[0].subnetGroup' <<<"${matches}")
  db_vpc=$(aws rds describe-db-subnet-groups --db-subnet-group-name "${subnet_group}" --output json | jq -r '.DBSubnetGroups[0].VpcId')
fi

service_vpc=$(aws ec2 describe-subnets --subnet-ids "${subnet}" --output json | jq -r '.Subnets[0].VpcId')
[ "${db_vpc}" = "${service_vpc}" ] || { echo "the database ${database} is not in the network of the service (${db_vpc} against ${service_vpc})" >&2; exit 1; }

echo "database=${database}"
echo "database_kind=${database_kind}"
echo "cluster=${cluster}"
