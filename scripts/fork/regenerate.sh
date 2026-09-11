#!/usr/bin/env bash
# Regenerate every tracked generated file (the `merge=regen` entries in
# .gitattributes) from the current sources, in dependency order, then stage them.
#
#   bash scripts/fork/regenerate.sh [--fresh] [--skip-db] [--no-stage]
#
#   --fresh     Wipe this worktree's local database volumes first so migrations are
#               applied from scratch. DESTROYS local dev data — meant for CI and
#               disposable stacks. Without it, pending migrations are applied on top
#               of the existing local database (the repo's normal `crbn migrate`),
#               so the output also reflects whatever that database already holds
#               (tables from other branches, seeded per-tenant objects). Only a
#               --fresh run, or CI, is authoritative for "are the committed files stale".
#   --skip-db   Skip the database-derived files (types, swagger, backup manifest).
#               Only for environments without Docker; CI must not use it.
#   --no-stage  Do not `git add` the regenerated files.
#
# The repository does not use `supabase start`: its local stack is a Docker
# compose project driven by the `crbn` CLI (packages/dev), which applies the
# migrations with `supabase migration up --include-all` and writes the database
# URL the generators read into .env.local. This script drives that runner.
#
# Order matters:
#   1. pnpm install            -> pnpm-lock.yaml (+ postinstall builds @carbon/documents
#                                 and regenerates the MCP tool digest)
#   2. migrations -> db:types  -> packages/database/src/types.ts and the functions/lib copy
#      generate:swagger        -> packages/database/src/swagger-docs-schema.ts (needs Studio)
#      db:check:backups        -> packages/jobs/manifests/schema.json
#   3. generate:mcp            -> apps/erp/.../tool-manifest.digest.json
#      generate:workflow-catalog (reads the swagger schema) -> packages/workflows/src/catalog/*.generated.ts
#      generate:agent-kb       -> apps/erp/app/modules/agent/kb/**
#   4. cargo update --workspace -> Cargo.lock
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
cd "$(fork_repo_root)"

fresh=0 skip_db=0 stage=1
for arg in "$@"; do
  case "$arg" in
    --fresh) fresh=1 ;;
    --skip-db) skip_db=1 ;;
    --no-stage) stage=0 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

command -v pnpm >/dev/null || die "pnpm is required (corepack enable && corepack prepare --activate)."
if (( ! skip_db )); then
  command -v docker >/dev/null || die "Docker is required to apply migrations. Install Docker Desktop (macOS) or docker-ce (Linux), or pass --skip-db for a source-only run."
  docker info >/dev/null 2>&1 || die "Docker is installed but the daemon is not running. Start Docker and retry."
fi

crbn="bash packages/dev/bin/crbn"

# The dev runner refuses to start without a root .env. The example file carries
# only placeholder values and is what a fresh clone (and CI) start from.
if (( ! skip_db )) && [[ ! -f .env ]]; then
  cp .env.example .env
  warn "no .env found: copied .env.example to .env (placeholder values, ignored by git)"
fi

# --- 1. Dependencies and lockfile -------------------------------------------
log "1/4 pnpm install (refreshes pnpm-lock.yaml; postinstall builds documents + MCP digest)"
pnpm install --prefer-offline

pnpm exec supabase --version >/dev/null 2>&1 || die "The Supabase CLI from the workspace catalog is not runnable (pnpm exec supabase --version). Run: pnpm rebuild supabase"

# --- 2. Database-derived files ---------------------------------------------
db_generators='pnpm db:types && pnpm generate:swagger && pnpm db:check:backups -- --stage'
if (( skip_db )); then
  warn "2/4 skipped database-derived files (--skip-db): types, swagger, backup manifest are NOT regenerated"
else
  if (( fresh )); then
    warn "2/4 --fresh: removing this worktree's database volumes before applying migrations"
    $crbn down --volumes || true
  fi
  port_db=""
  if [[ -f .env.local ]]; then
    port_db="$(sed -n 's/^PORT_DB=//p' .env.local | tr -d '"' | head -1)"
  fi
  if [[ -n "$port_db" ]] && (exec 3<>"/dev/tcp/127.0.0.1/$port_db") 2>/dev/null; then
    log "2/4 local database is running on port $port_db: applying pending migrations, then regenerating"
    $crbn migrate --no-regen
    bash -c "$db_generators"
  else
    log "2/4 no running local database: booting a services-only stack, migrating, regenerating, tearing down"
    run_flags=(--no-apps --no-portless --no-regen)
    (( fresh )) && run_flags+=(--volumes)
    $crbn up "${run_flags[@]}" --run "$db_generators"
  fi
fi

# The backup manifest records `exportedAt` and lists columns in catalog order,
# neither of which is stable across runs. Keep the committed bytes when the
# regenerated manifest is semantically identical (same tables, same column
# sets, same everything else), so a no-op regeneration is a no-op in git too.
manifest="packages/jobs/manifests/schema.json"
if (( ! skip_db )) && git cat-file -e "HEAD:$manifest" 2>/dev/null; then
  if node -e '
    const fs = require("fs");
    const norm = (t) => { const d = JSON.parse(t); delete d.exportedAt;
      d.tables = (d.tables ?? []).map((x) => ({ ...x, columns: [...(x.columns ?? [])].sort() }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return JSON.stringify(d); };
    process.exit(norm(fs.readFileSync(process.argv[1], "utf8")) === norm(fs.readFileSync(0, "utf8")) ? 0 : 1);
  ' "$manifest" < <(git show "HEAD:$manifest"); then
    git checkout --quiet HEAD -- "$manifest"
    log "backup manifest unchanged semantically; kept the committed bytes"
  else
    warn "backup manifest changed (tables or columns differ from HEAD); review the diff"
  fi
fi

# --- 3. Source-derived files -------------------------------------------------
log "3/4 source-derived generators (mcp digest, workflow catalog, agent knowledge base)"
pnpm run generate:mcp
pnpm run generate:workflow-catalog
pnpm run generate:agent-kb
# The pre-commit hook (lint-staged) formats *.json with biome, so the committed
# manifest is biome-formatted; match it or the drift check would always differ.
pnpm exec biome format --write apps/erp/app/modules/agent/kb/manifest.json >/dev/null

# --- 4. Rust lockfile --------------------------------------------------------
if command -v cargo >/dev/null; then
  log "4/4 cargo update --workspace (re-syncs Cargo.lock with the workspace manifests only)"
  cargo update --workspace --offline >/dev/null 2>&1 || cargo update --workspace
else
  warn "4/4 cargo not found: Cargo.lock was not re-synced (install rustup if a merge touched Cargo.toml)"
fi

# --- Stage and report ---------------------------------------------------------
if (( stage )); then
  regen_paths | tr '\n' '\0' | xargs -0 git add -- 2>/dev/null || true
  # Regenerated directories can gain or lose files; make sure the glob'd trees are staged too.
  git add -A -- apps/erp/app/modules/agent/kb packages/workflows/src/catalog
fi
log "done. git status --short:"
git status --short
