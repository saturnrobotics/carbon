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

if [ "$mode" = "e2e" ]; then
  docker build \
    --file contrib/deploying/knowledge/Dockerfile.schema \
    --target runtime \
    --tag knowledge-manual-local-schema:manual-v1 \
    .
  for unit in ingest web parser; do
    docker build \
      --file "contrib/deploying/knowledge/Dockerfile.$unit" \
      --target e2e \
      --tag "knowledge-manual-local-$unit-e2e:manual-v1" \
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
    --tag "knowledge-manual-local-$unit:manual-v1$suffix" \
    .
done
