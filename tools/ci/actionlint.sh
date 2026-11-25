#!/usr/bin/env bash
# actionlint with the pinned shellcheck, named explicitly. actionlint hands the `run:` scripts of the workflows to shellcheck only when it finds one; without one it says nothing and exits 0, so
# a bare `! cmd` (SC2251) would pass. Here a shellcheck that cannot be found is an error: `mise which` that fails stops the script, and one that prints nothing is refused below.
set -eu
shellcheck="$(mise which shellcheck)"
if [ -z "$shellcheck" ] || [ ! -x "$shellcheck" ]; then
  echo "::error::the pinned shellcheck was not found (mise install), so the workflow scripts cannot be linted" >&2
  exit 1
fi
exec actionlint -shellcheck "$shellcheck" "$@"
