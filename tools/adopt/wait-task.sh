#!/usr/bin/env bash
# Waits until an ECS task has stopped, by polling its own status (the AWS waiter gives up after about ten minutes, and a task that sets up and then adopts may run longer; the caller's
# timeout bounds this). A failing call (a bad role, no access) or an unknown status stops at once with an error; only a task that is still on its way is waited for, a pause at a time.
# ECS is eventually consistent: the task `run-task` just started may not be visible to `describe-tasks` yet, so a task not seen yet is waited for too, but only for a bounded window
# (`ADOPT_VISIBLE_POLLS` polls, 4 by default: a minute at the default pause, counted in polls so that a slow runner cannot change the outcome); one that was seen and then is gone, or never appears, stops with an error. `ADOPT_POLL_SECONDS` sets the pause (15 by default).
set -euo pipefail
cluster="${1:-}"
task="${2:-}"
[ -n "${cluster}" ] && [ -n "${task}" ] || { echo "usage: wait-task.sh <cluster> <task>" >&2; exit 2; }
seen=no
missing=0
while :; do
  status=$(aws ecs describe-tasks --cluster "${cluster}" --tasks "${task}" --output json | jq -r '.tasks[0].lastStatus // "none"')
  case "${status}" in
    STOPPED) exit 0 ;;
    PROVISIONING | PENDING | ACTIVATING | RUNNING | DEACTIVATING | STOPPING | DEPROVISIONING) seen=yes; sleep "${ADOPT_POLL_SECONDS:-15}" ;;
    none)
      missing=$((missing + 1))
      if [ "${seen}" = "no" ] && [ "${missing}" -le "${ADOPT_VISIBLE_POLLS:-4}" ]; then
        sleep "${ADOPT_POLL_SECONDS:-15}"
      else
        [ "${seen}" = "no" ] && how="never seen" || how="seen, then gone"
        echo "the task ${task##*/} is not known to ECS (${how})" >&2
        exit 1
      fi
      ;;
    *) echo "the task ${task##*/} has an unexpected status: ${status}" >&2; exit 1 ;;
  esac
done
