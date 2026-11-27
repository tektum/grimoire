#!/bin/sh
# Installs the browsers of the Playwright in use, then the operating system libraries they need. Both steps go to the network (the browser archives, the apt mirrors),
# and a runner whose mirror answers badly (apt exit 100) or hangs (a 28 minute WebKit install) is not a product failure: each step is tried up to three times, one
# attempt ends after PLAYWRIGHT_ATTEMPT_TIMEOUT seconds (240; the slowest healthy install seen was 357 s, in one run, and its retry is fast), the waits are 15 and 45
# seconds, and the two steps together stop trying after PLAYWRIGHT_TOTAL_SECONDS (600), so the failure message is printed long before the budget of the shortest job
# (20 minutes). Before a retry of the libraries, `dpkg --configure -a` (at most 120 s) repairs what a killed apt left half done; the attempt, the wait and the repair are all cut by what is left of the total. apt retries each download five times itself. The
# last line says how long it took.
# Usage: playwright-install.sh BROWSER...   Overrides, for the tests: PLAYWRIGHT_CMD, PLAYWRIGHT_RETRY_DELAYS, PLAYWRIGHT_ATTEMPT_TIMEOUT, PLAYWRIGHT_TOTAL_SECONDS,
# PLAYWRIGHT_REPAIR_CMD ("" repairs nothing), PLAYWRIGHT_APT_CONF ("" writes nothing), PLAYWRIGHT_APT_SOURCES ("" removes nothing).
# The runner image lists the Microsoft package repository, which the install does not use and whose signing has been refused by that repository (403 "no longer signed": apt-get update exits 100 on every try,
# so the libraries can never be installed). Before the first apt call, every file of the apt sources folder that names packages.microsoft.com (whatever the file is called) is removed; each removal is said, or
# the failure of it (PLAYWRIGHT_SUDO, "sudo" by default, is what runs when plain rm is refused or the file cannot be read; PLAYWRIGHT_RM, "rm", is the removal command: the tests set both to `false` to simulate a removal that fails whoever runs them).
# The whole file goes, not some of its lines: a file of that folder is one repository by the convention of the tools that write them (the runner has microsoft-prod.list, which holds that repository only).
set -u
[ "$#" -gt 0 ] || { echo "usage: playwright-install.sh BROWSER..." >&2; exit 2; }
cmd=${PLAYWRIGHT_CMD:-bunx playwright}
delays=${PLAYWRIGHT_RETRY_DELAYS:-"15 45"}
limit=${PLAYWRIGHT_ATTEMPT_TIMEOUT:-240}
total=${PLAYWRIGHT_TOTAL_SECONDS:-600}
repair=${PLAYWRIGHT_REPAIR_CMD-sudo dpkg --configure -a}
apt_conf=${PLAYWRIGHT_APT_CONF-/etc/apt/apt.conf.d/80-retries}
apt_sources=${PLAYWRIGHT_APT_SOURCES-/etc/apt/sources.list.d}
sudo=${PLAYWRIGHT_SUDO-sudo}
rm_cmd=${PLAYWRIGHT_RM-rm}

if [ -n "$apt_sources" ]; then
  for source in "$apt_sources"/*; do
    [ -f "$source" ] || continue
    # grep says 1 for "no match" and 2 for "could not read it": a file only root can read is read again through sudo, not skipped
    grep -qi 'packages\.microsoft\.com' "$source" 2>/dev/null; found=$?
    if [ "$found" -eq 2 ]; then $sudo grep -qi 'packages\.microsoft\.com' "$source" 2>/dev/null; found=$?; fi
    [ "$found" -eq 0 ] || continue
    "$rm_cmd" -f "$source" 2>/dev/null || $sudo "$rm_cmd" -f "$source" 2>/dev/null
    if [ -e "$source" ]; then echo "could not remove the apt source $source (apt will fail on it)" >&2
    else echo "removed the apt source $source (it points at packages.microsoft.com, which refuses its own signature; not used here)"; fi
  done
fi

if [ -n "$apt_conf" ]; then echo 'Acquire::Retries "5";' | sudo tee "$apt_conf" >/dev/null; fi

started=$(date +%s)

remaining() { echo $((total - ($(date +%s) - started))); }

# with_retry STEP BROWSER...: STEP is `install` or `install-deps`; only a retry of `install-deps` repairs dpkg first. Every wait for the clock below is cut by what is left of the
# total: an attempt, the wait before the next one and the repair each get no more than the time that remains, and no attempt starts when there is none.
with_retry() {
  attempt=1
  for wait in $delays ""; do
    left=$(remaining)
    if [ "$left" -le 0 ]; then echo "'$cmd $*': the ${total}s for the whole install are used up" >&2; break; fi
    [ "$left" -lt "$limit" ] && budget=$left || budget=$limit
    # shellcheck disable=SC2086
    if timeout "$budget" $cmd "$@"; then return 0; fi
    if [ -z "$wait" ]; then break; fi
    left=$(remaining)
    if [ "$left" -le "$wait" ]; then echo "'$cmd $*' failed (attempt $attempt) and the ${total}s for the whole install are used up" >&2; break; fi
    echo "'$cmd $*' failed (attempt $attempt), trying again in ${wait}s" >&2
    sleep "$wait"
    attempt=$((attempt + 1))
    if [ "$1" = install-deps ] && [ -n "$repair" ]; then
      left=$(remaining)
      [ "$left" -lt 120 ] && budget=$left || budget=120
      # shellcheck disable=SC2086
      [ "$budget" -gt 0 ] && { timeout "$budget" $repair >&2 || true; }
    fi
  done
  echo "'$cmd $*' failed after $attempt attempts (a download or a package mirror did not answer, or the time for the install ran out; this is not a test failure)" >&2
  return 1
}

with_retry install "$@" || exit 1
with_retry install-deps "$@" || exit 1
echo "::notice::Playwright $*: installed in $(($(date +%s) - started)) s"
