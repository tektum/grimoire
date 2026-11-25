#!/usr/bin/env bash
# The gate after a deploy: the run is green only when the stage serves. It polls the service of the stage until its one deployment is complete with every task running and the site answers
# /readyz with 200, for HEALTHY_POLLS polls in a row, and stops red when the rollout is marked failed or MAX_POLLS polls (counted, not timed, so a slow runner changes nothing) pass without it.
# A deploy that leaves the load balancer with no target used to end green. Needs `aws`, `curl` and `jq`; run with the stage's credentials.
set -euo pipefail
stage="${1:-}"
host="${2:-}"
[[ "${stage}" =~ ^[a-z][a-z0-9-]*$ ]] && [[ "${host}" =~ ^[a-z0-9.-]+$ ]] || { echo "usage: wait-healthy.sh <stage> <host>" >&2; exit 2; }

cluster=$(aws ecs list-clusters --output json | jq -r --arg re "^arn:aws[a-z-]*:ecs:[a-z0-9-]+:[0-9]+:cluster/grimoire-${stage}-ClusterCluster-[a-z0-9]+\$" '[.clusterArns[] | select(test($re))] | if length == 1 then .[0] else empty end')
[ -n "${cluster}" ] || { echo "expected one cluster of the stage ${stage}" >&2; exit 1; }

good=0
for ((poll = 1; poll <= ${MAX_POLLS:-40}; poll++)); do
  service=$(aws ecs describe-services --cluster "${cluster}" --services Server --output json | jq -c '.services[0] | {running: .runningCount, desired: .desiredCount, deployments: [.deployments[] | {status, state: .rolloutState}]}')
  if jq -e 'any(.deployments[]; .status == "PRIMARY" and .state == "FAILED")' <<<"${service}" >/dev/null; then
    echo "the rollout of the stage ${stage} failed: ${service}" >&2
    exit 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${host}/readyz" || true)
  if jq -e '(.deployments | length) == 1 and .deployments[0].state == "COMPLETED" and .running == .desired and .desired > 0' <<<"${service}" >/dev/null && [ "${code}" = "200" ]; then
    good=$((good + 1))
    echo "poll ${poll}: healthy (${good} of ${HEALTHY_POLLS:-3})"
    [ "${good}" -ge "${HEALTHY_POLLS:-3}" ] && exit 0
  else
    good=0
    echo "poll ${poll}: not yet (readyz ${code:-none}, service ${service})"
  fi
  sleep "${POLL_SECONDS:-15}"
done
echo "the stage ${stage} did not become healthy in ${MAX_POLLS:-40} polls: readyz ${code:-none}, service ${service}" >&2
exit 1
