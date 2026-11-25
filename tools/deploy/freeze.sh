#!/usr/bin/env bash
# Stops (freeze) or restarts (thaw) the one task of a stage's service, so that nothing writes to the stage's database while it is copied (the move to Aurora,
# docs/operations/database-setup.md). freeze suspends the service's autoscaling first (its minimum would start a task again), sets the count to 0 and waits until no task runs;
# thaw sets a stopped service back to the autoscaling minimum and resumes the autoscaling. Every deploy thaws before its gate, so a deploy never leaves a stage frozen.
# Needs `aws` and `jq`; run with the stage's credentials.
set -euo pipefail
mode="${1:-}"
stage="${2:-}"
[[ "${mode}" =~ ^(freeze|thaw)$ ]] && [[ "${stage}" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "usage: freeze.sh freeze|thaw <stage>" >&2; exit 2; }

cluster=$(aws ecs list-clusters --output json | jq -r --arg re "^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]+:cluster/grimoire-${stage}-ClusterCluster-[a-z0-9]+\$" '[.clusterArns[] | select(test($re))] | if length == 1 then .[0] else empty end')
[ -n "${cluster}" ] || { echo "expected one cluster of the stage ${stage}" >&2; exit 1; }
target="service/${cluster##*/}/Server"
scaling() { aws application-autoscaling register-scalable-target --service-namespace ecs --scalable-dimension ecs:service:DesiredCount --resource-id "${target}" --suspended-state "DynamicScalingInSuspended=$1,DynamicScalingOutSuspended=$1,ScheduledScalingSuspended=$1"; }
count() { aws ecs update-service --cluster "${cluster}" --service Server --desired-count "$1" --query service.desiredCount --output text; }

if [ "${mode}" = freeze ]; then
  scaling true
  count 0
  aws ecs wait services-stable --cluster "${cluster}" --services Server
  echo "the service of ${stage} runs no task: nothing writes to its database until a deploy starts it again"
else
  if [ "$(aws ecs describe-services --cluster "${cluster}" --services Server --query 'services[0].desiredCount' --output text)" = 0 ]; then
    count "$(aws application-autoscaling describe-scalable-targets --service-namespace ecs --resource-ids "${target}" --query 'ScalableTargets[0].MinCapacity' --output text)"
  fi
  scaling false
fi
