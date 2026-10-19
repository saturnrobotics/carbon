#!/bin/sh
# WAL-G inside the Supabase PostgreSQL image, mounted read-only as
# /usr/local/bin/wal-g in INGRESS_MODE=private-lb (see wal_g.py).
#
# WAL-G's PostgreSQL release binary is linked against glibc, but the image's
# userland is musl and has no glibc loader at the path the binary names.
# PostgreSQL itself runs on glibc from the image's Nix store, so run the pinned
# binary with the newest glibc loader found there, against that glibc's own
# libraries. Every failure exits non-zero: PostgreSQL then keeps the WAL segment
# and retries archiving.
set -eu
binary=/usr/local/lib/carbon-wal-g/wal-g
store=/nix/store
loader=$(
  for candidate in "$store"/*-glibc-*/lib/ld-linux-*.so.[0-9]; do
    [ -x "$candidate" ] || continue
    version=${candidate#"$store"/*-glibc-}
    printf '%s %s\n' "${version%%/*}" "$candidate"
  done | awk '{
    split($1, part, /[.-]/)
    key = sprintf("%06d%06d%06d", part[1], part[2], part[3])
    if (key > best) { best = key; path = $2 }
  } END { print path }'
)
[ -n "$loader" ] || { echo 'wal-g: no glibc loader in this image' >&2; exit 1; }
# --argv0 keeps WAL-G's own name, so anything it re-executes runs through here.
exec "$loader" --library-path "${loader%/*}" --argv0 "$0" "$binary" "$@"
