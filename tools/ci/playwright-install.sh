#!/bin/sh
# Installs the browsers of the Playwright in use, then the operating system libraries they need. Both steps go to the network (the browser archives, the apt mirrors),
# and a runner whose mirror answers badly (apt exit 100) or hangs (a 28 minute WebKit install) is not a product failure: each step is tried up to three times, one
# attempt ends after PLAYWRIGHT_ATTEMPT_TIMEOUT seconds (240; the slowest healthy install seen was 357 s, in one run, and its retry is fast), the waits are 15 and 45
# seconds, and the two steps together stop trying after PLAYWRIGHT_TOTAL_SECONDS (600), so the failure message is printed long before the budget of the shortest job
# (20 minutes). Before a retry of the libraries, `dpkg --configure -a` repairs what a killed apt left half done. apt retries each download five times itself. The
# browsers already in ~/.cache/ms-playwright (restored by the cache step of the job) are not downloaded again. The last line says how long it took and whether the cache had them.
# Usage: playwright-install.sh BROWSER...   Overrides, for the tests: PLAYWRIGHT_CMD, PLAYWRIGHT_RETRY_DELAYS, PLAYWRIGHT_ATTEMPT_TIMEOUT, PLAYWRIGHT_TOTAL_SECONDS,
# PLAYWRIGHT_REPAIR_CMD ("" repairs nothing), PLAYWRIGHT_APT_CONF ("" writes nothing).
set -u
[ "$#" -gt 0 ] || { echo "usage: playwright-install.sh BROWSER..." >&2; exit 2; }
cmd=${PLAYWRIGHT_CMD:-bunx playwright}
delays=${PLAYWRIGHT_RETRY_DELAYS:-"15 45"}
limit=${PLAYWRIGHT_ATTEMPT_TIMEOUT:-240}
total=${PLAYWRIGHT_TOTAL_SECONDS:-600}
repair=${PLAYWRIGHT_REPAIR_CMD-sudo dpkg --configure -a}
apt_conf=${PLAYWRIGHT_APT_CONF-/etc/apt/apt.conf.d/80-retries}

if [ -n "$apt_conf" ]; then echo 'Acquire::Retries "5";' | sudo tee "$apt_conf" >/dev/null; fi

started=$(date +%s)

# with_retry STEP BROWSER...: STEP is `install` or `install-deps`; only a retry of `install-deps` repairs dpkg first.
with_retry() {
  attempt=1
  for wait in $delays ""; do
    left=$((total - ($(date +%s) - started)))
    if [ "$left" -le 0 ]; then echo "'$cmd $*': the ${total}s for the whole install are used up" >&2; break; fi
    [ "$left" -lt "$limit" ] && budget=$left || budget=$limit
    # shellcheck disable=SC2086
    if timeout "$budget" $cmd "$@"; then return 0; fi
    if [ -z "$wait" ]; then break; fi
    echo "'$cmd $*' failed (attempt $attempt), trying again in ${wait}s" >&2
    sleep "$wait"
    attempt=$((attempt + 1))
    # shellcheck disable=SC2086
    if [ "$1" = install-deps ] && [ -n "$repair" ]; then $repair >&2 || true; fi
  done
  echo "'$cmd $*' failed after $attempt attempts (a download or a package mirror did not answer, or the time for the install ran out; this is not a test failure)" >&2
  return 1
}

with_retry install "$@" || exit 1
with_retry install-deps "$@" || exit 1
echo "::notice::Playwright $*: installed in $(($(date +%s) - started)) s (browser cache hit: ${PLAYWRIGHT_CACHE_HIT:-false})"
