#!/usr/bin/env bash
# The read-only check of a stage's database (descope-infra.yml action=check): runs tools/deploy/db-check.js as a one-off task of the stage's service, in its migration
# container (the migrator's connection, inside the stage's network: tenant-adopt.yml's pattern), with db-setup and the app made to exit at once so that nothing but the check
# runs, and prints what the check said. Exits 1 when the task did not start or the check did not finish. Needs `aws` and `jq`; run with the stage's credentials.
set -euo pipefail
cluster="${1:-}"
[[ "${cluster}" =~ ^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]+:cluster/[A-Za-z0-9-]+$ ]] || { echo "usage: db-check.sh <ecs cluster arn>" >&2; exit 2; }
here="$(dirname "$0")"
service=$(aws ecs describe-services --cluster "${cluster}" --services Server --query 'services[0]' --output json)
taskdef=$(jq -r '.taskDefinition' <<<"${service}")
network=$(jq -c '{awsvpcConfiguration: .networkConfiguration.awsvpcConfiguration}' <<<"${service}")
overrides=$(jq -nc --rawfile js "${here}/db-check.js" '{containerOverrides: [{name: "db-setup", command: ["-e", "0"]}, {name: "migrate", command: ["-e", $js]}, {name: "app", command: ["-e", "0"]}]}')
task=$(aws ecs run-task --cluster "${cluster}" --task-definition "${taskdef}" --launch-type FARGATE --network-configuration "${network}" --overrides "${overrides}" --query 'tasks[0].taskArn' --output text)
[ -n "${task}" ] && [ "${task}" != "None" ] || { echo "the task did not start" >&2; exit 1; }
echo "task ${task##*/} on ${taskdef##*/}"
bash "${here}/../adopt/wait-task.sh" "${cluster}" "${task}"
code=$(aws ecs describe-tasks --cluster "${cluster}" --tasks "${task}" --query "tasks[0].containers[?name=='migrate'] | [0].exitCode" --output text)
group=$(aws ecs describe-task-definition --task-definition "${taskdef}" --query "taskDefinition.containerDefinitions[?name=='migrate'] | [0].logConfiguration.options.\"awslogs-group\"" --output text)
prefix=$(aws ecs describe-task-definition --task-definition "${taskdef}" --query "taskDefinition.containerDefinitions[?name=='migrate'] | [0].logConfiguration.options.\"awslogs-stream-prefix\"" --output text)
aws logs get-log-events --log-group-name "${group}" --log-stream-name "${prefix}/migrate/${task##*/}" --query 'events[].message' --output text | tr '\t' '\n'
[ "${code}" = "0" ] || { echo "the check did not finish (exit ${code})" >&2; exit 1; }
