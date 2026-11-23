#!/bin/sh
# Pulls the images the stack needs that are not on this machine yet: the `image:` entries of the Compose files in use and the external base images of the
# Dockerfile. A registry that answers badly for a moment (a token request that times out) is not a product failure: each pull is tried up to four times
# with waits of 5, 15 and 30 seconds, and the failure says so ("image pull failed after 4 attempts"). Images already present are not asked for again, so an
# offline machine with its images keeps working. Pulls only: no credentials are used and nothing else is retried.
# Usage: pull-images.sh [--no-bases] [SERVICE...]: with service names only the images of those services are considered (what `make db-up` starts), with --no-bases the
# Dockerfile's bases are left alone (they are only needed to build the app image). PULL_RETRY_DELAYS (seconds, space separated) overrides the waits; the tests use it.
set -u
delays=${PULL_RETRY_DELAYS:-"5 15 30"}
compose=${COMPOSE_CMD:-docker compose -p grimoire}
dockerfile=${DOCKERFILE:-Dockerfile}
bases_wanted=1
if [ "${1:-}" = --no-bases ]; then bases_wanted=0; shift; fi

# A daemon that cannot be reached would make every `docker image inspect` fail and read as "image missing": say what it is instead of retrying pulls.
docker info >/dev/null 2>&1 || { echo "the Docker daemon cannot be reached (not a registry problem)" >&2; exit 2; }

pull_with_retry() {
  image=$1
  attempt=1
  for wait in $delays ""; do
    if docker pull --quiet "$image" >/dev/null 2>&1; then echo "pulled $image (attempt $attempt)"; return 0; fi
    if [ -z "$wait" ]; then break; fi
    echo "pull of $image failed (attempt $attempt), trying again in ${wait}s" >&2
    sleep "$wait"
    attempt=$((attempt + 1))
  done
  echo "image pull failed after $attempt attempts: $image (the registry did not answer; this is not a test failure)" >&2
  return 1
}

# Compose names the images it builds `<project>-<service>`: those are built, not pulled. Compose is asked once; a failure to read the files is a real error.
built_or_listed=$($compose config --images "$@") || { echo "could not read the Compose files" >&2; exit 2; }
bases=""
if [ "$bases_wanted" = 1 ] && [ -f "$dockerfile" ]; then
  stages=""
  while read -r from rest; do
    [ "$from" = FROM ] || continue
    # shellcheck disable=SC2086 # the words of the line are the point
    set -- $rest
    case "$1" in --platform=*) shift ;; esac
    image=$1
    case " $stages " in *" $image "*) ;; *) bases="$bases $image" ;; esac
    [ "${2:-}" = AS ] && [ -n "${3:-}" ] && stages="$stages $3"
  done < "$dockerfile"
fi

status=0
for image in $built_or_listed $bases; do
  case "$image" in grimoire-*) continue ;; esac
  if docker image inspect "$image" >/dev/null 2>&1; then continue; fi
  pull_with_retry "$image" || status=1
done
exit $status
