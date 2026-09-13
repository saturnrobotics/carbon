#!/bin/sh
set -eu

case "${1:-native}" in
  native)
    mode="production"
    platform=""
    suffix=""
    ;;
  amd64)
    mode="production"
    platform="linux/amd64"
    suffix="-amd64"
    ;;
  e2e)
    mode="e2e"
    platform=""
    suffix=""
    ;;
  *)
    echo "usage: $0 [native|amd64|e2e]" >&2
    exit 2
    ;;
esac

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$root"

# Stack name and tag are overridable so a concurrent harness can build its own
# images alongside a running stack without retagging anyone else's. Both
# default to the historical values, so an unparameterised invocation — CI's —
# is unchanged.
stack=${PORTAL_LOCAL_STACK:-portal-manual-local}
tag=${PORTAL_LOCAL_TAG:-manual-v1}

if [ "$mode" = "e2e" ]; then
  docker build \
    --file contrib/deploying/portal/Dockerfile.schema \
    --target runtime \
    --tag "$stack-schema:$tag" \
    .
  for unit in ingest web parser; do
    # Only the disposable web harness admits the deferred Drive surface, and
    # only through the `e2e` stage's build argument. No release build below
    # passes it, and the release `runtime` stage cannot receive it at all.
    if [ "$unit" = web ]; then
      set -- --build-arg PORTAL_DRIVE_ENABLED=true
    else
      set --
    fi
    docker build \
      "$@" \
      --file "contrib/deploying/portal/Dockerfile.$unit" \
      --target e2e \
      --tag "$stack-$unit-e2e:$tag" \
      .
  done
  exit 0
fi

for unit in web query ingest parser schema retention; do
  if [ -n "$platform" ]; then
    set -- --platform "$platform"
  else
    set --
  fi
  docker build \
    "$@" \
    --file "contrib/deploying/portal/Dockerfile.$unit" \
    --target runtime \
    --tag "$stack-$unit:$tag$suffix" \
    .
done
