#!/usr/bin/env bash
# The gate after a deploy: the run is green only when the stage serves. It polls the service of the stage until its one deployment is complete with every task running and the site answers
# /readyz with 200, for HEALTHY_POLLS polls in a row, and stops red when any deployment is marked failed (a rollback by the circuit breaker leaves the failed one active) or MAX_POLLS polls (counted,
# not timed, so a slow runner changes nothing) pass without it. The deployment that serves must also run the latest task definition of the service: after a rollback the failed deployment is gone and the old
# code answers 200, which only the definition tells apart.
# A deploy that leaves the load balancer with no target used to end green. Needs `aws`, `curl` and `jq`; run with the stage's credentials.
set -euo pipefail
stage="${1:-}"
host="${2:-}"
[[ "${stage}" =~ ^[a-z][a-z0-9-]*$ ]] && [[ "${host}" =~ ^[a-z0-9.-]+$ ]] || { echo "usage: wait-healthy.sh <stage> <host>" >&2; exit 2; }

cluster=$(aws ecs list-clusters --output json | jq -r --arg re "^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]+:cluster/grimoire-${stage}-ClusterCluster-[a-z0-9]+\$" '[.clusterArns[] | select(test($re))] | if length == 1 then .[0] else empty end')
[ -n "${cluster}" ] || { echo "expected one cluster of the stage ${stage}" >&2; exit 1; }

good=0
why="no poll made"
for ((poll = 1; poll <= ${MAX_POLLS:-40}; poll++)); do
  service=$(aws ecs describe-services --cluster "${cluster}" --services Server --output json | jq -c '.services[0] | {running: .runningCount, desired: .desiredCount, deployments: [.deployments[] | {status, state: .rolloutState, definition: .taskDefinition}]}')
  if jq -e 'any(.deployments[]; .state == "FAILED")' <<<"${service}" >/dev/null; then
    echo "the rollout of the stage ${stage} failed: ${service}" >&2
    exit 1
  fi
  serving=$(jq -r '[.deployments[] | select(.status == "PRIMARY") | .definition] | first // ""' <<<"${service}")
  family=$(basename "${serving%:*}")
  latest=$(aws ecs list-task-definitions --family-prefix "${family}" --sort DESC --output json | jq -r --arg f "${family}" '[.taskDefinitionArns[] | select((split("/")[-1] | split(":")[0]) == $f)] | .[0] // ""')
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${host}/readyz" || true)
  if [ -n "${serving}" ] && [ "${serving}" != "${latest}" ]; then
    good=0
    why="${serving##*/} is not the latest task definition (${latest##*/}), so the deploy did not take: the service runs the code it had before"
    echo "poll ${poll}: ${why}"
  elif jq -e '(.deployments | length) == 1 and .deployments[0].state == "COMPLETED" and .running == .desired and .desired > 0' <<<"${service}" >/dev/null && [ "${code}" = "200" ]; then
    good=$((good + 1))
    echo "poll ${poll}: healthy (${good} of ${HEALTHY_POLLS:-3})"
    [ "${good}" -ge "${HEALTHY_POLLS:-3}" ] && exit 0
  else
    good=0
    why="readyz ${code:-none}, service ${service}"
    echo "poll ${poll}: not yet (${why})"
  fi
  sleep "${POLL_SECONDS:-15}"
done
echo "the stage ${stage} did not become healthy in ${MAX_POLLS:-40} polls: ${why}" >&2
exit 1
