#!/usr/bin/env bash
# Waits until an ECS task has stopped, by polling its own status (the AWS waiter gives up after about ten minutes, and a task that sets up and then adopts may run longer; the caller's
# timeout bounds this). A failing call (a bad role, no access) or an unknown status stops at once with an error; only a task that is still on its way is waited for, a pause at a time.
# `ADOPT_POLL_SECONDS` sets the pause (15 by default).
set -euo pipefail
cluster="${1:-}"
task="${2:-}"
[ -n "${cluster}" ] && [ -n "${task}" ] || { echo "usage: wait-task.sh <cluster> <task>" >&2; exit 2; }
while :; do
  status=$(aws ecs describe-tasks --cluster "${cluster}" --tasks "${task}" --output json | jq -r '.tasks[0].lastStatus // "none"')
  case "${status}" in
    STOPPED) exit 0 ;;
    PROVISIONING | PENDING | ACTIVATING | RUNNING | DEACTIVATING | STOPPING | DEPROVISIONING) sleep "${ADOPT_POLL_SECONDS:-15}" ;;
    *) echo "the task ${task##*/} has an unexpected status: ${status}" >&2; exit 1 ;;
  esac
done
