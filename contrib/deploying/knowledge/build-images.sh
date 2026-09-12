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

# Stack name and tag are overridable so a second local stack can be built
# alongside a running one without retagging its images. CI leaves both unset.
stack=${KNOWLEDGE_LOCAL_STACK:-knowledge-manual-local}
tag=${KNOWLEDGE_LOCAL_TAG:-manual-v1}

if [ "$mode" = "e2e" ]; then
  docker build \
    --file contrib/deploying/knowledge/Dockerfile.schema \
    --target runtime \
    --tag "$stack-schema:$tag" \
    .
  for unit in ingest web parser; do
    docker build \
      --file "contrib/deploying/knowledge/Dockerfile.$unit" \
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
    --file "contrib/deploying/knowledge/Dockerfile.$unit" \
    --target runtime \
    --tag "$stack-$unit:$tag$suffix" \
    .
done
