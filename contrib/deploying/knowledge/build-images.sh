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

# A concurrent harness must be able to build its own images without retagging
# anyone else's. Both default to the historical values, so an unparameterised
# invocation is unchanged.
prefix=${KNOWLEDGE_IMAGE_PREFIX:-knowledge-manual-local}
tag=${KNOWLEDGE_IMAGE_TAG:-manual-v1}

root=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
cd "$root"

if [ "$mode" = "e2e" ]; then
  docker build \
    --file contrib/deploying/knowledge/Dockerfile.schema \
    --target runtime \
    --tag "$prefix-schema:$tag" \
    .
  for unit in ingest web parser; do
    # Only the disposable web harness admits the deferred Drive surface, and
    # only through the `e2e` stage's build argument. No release build below
    # passes it, and the release `runtime` stage cannot receive it at all.
    if [ "$unit" = web ]; then
      set -- --build-arg KNOWLEDGE_DRIVE_ENABLED=true
    else
      set --
    fi
    docker build \
      "$@" \
      --file "contrib/deploying/knowledge/Dockerfile.$unit" \
      --target e2e \
      --tag "$prefix-$unit-e2e:$tag" \
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
    --file "contrib/deploying/knowledge/Dockerfile.$unit" \
    --target runtime \
    --tag "$prefix-$unit:$tag$suffix" \
    .
done
