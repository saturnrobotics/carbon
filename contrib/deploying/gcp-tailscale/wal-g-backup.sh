#!/usr/bin/env bash
# One WAL-G base backup of Carbon's running PostgreSQL (INGRESS_MODE=private-lb).
#
# bootstrap.sh installs this as /usr/local/sbin/carbon-wal-g-backup, and
# carbon-wal-g-backup.timer runs it daily at 07:00 UTC. To take one on demand,
# for example the first right after deploying, run on the VM:
#   sudo systemctl start carbon-wal-g-backup.service
# It returns when the backup ends; read its output with
#   sudo journalctl -u carbon-wal-g-backup.service
set -euo pipefail
readonly PGDATA=/var/lib/postgresql/data

# Wait up to ten minutes for PostgreSQL, for a run that starts at boot. A
# stopped Docker fails at once: maintenance stops it for a disk snapshot.
container=
for _ in {1..60}; do
  container=$(docker ps --filter label=com.docker.compose.project=carbon \
    --filter label=com.docker.compose.service=postgres --filter status=running --quiet)
  if [[ -n $container && $container != *$'\n'* ]] && docker exec "$container" pg_isready -q -h 127.0.0.1; then
    break
  fi
  container=
  sleep 10
done
[[ -n $container ]] || { echo 'Carbon PostgreSQL is not running and ready; no base backup was taken.' >&2; exit 1; }

# As the superuser over the container's loopback, as host-deploy.sh runs SQL.
# WAL-G reads PGDATA as the postgres user and its settings from the env file.
exec docker exec --user postgres --env PGHOST=127.0.0.1 --env PGUSER=supabase_admin "$container" \
  /usr/local/bin/carbon-secrets-entrypoint.sh wal-g backup-push "$PGDATA"
