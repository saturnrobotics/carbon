# Fork conventions

The fork's diff against upstream is a cost paid on every sync. These conventions
keep it small and make each remaining shared-file change deliberate. They apply to
every PR into `saturn/main`.

## 1. Fork-specific code lives in fork-owned locations

Put new fork-only code where upstream never writes, so it can never conflict:

| Kind of code | Location | Why here |
| --- | --- | --- |
| ERP features (routes, services, models, UI) | `apps/erp/app/modules/saturn/` — one module, following the standard `{module}.models.ts` / `{module}.service.ts` / `ui/` layout | mirrors the existing module layout; a `saturn` module is unmistakably ours |
| ERP routes for that module | `apps/erp/app/routes/x+/saturn+/` (flat routes, like every other module) | keeps the route tree disjoint from upstream's |
| Shared packages | `packages/saturn-<name>/` (workspace `@carbon/saturn-<name>`) | the `packages/*` workspace glob picks it up with no `pnpm-workspace.yaml` edit |
| Standalone apps and workers | `apps/saturn-<name>/` (`apps/knowledge*` predate this rule and stay where they are) | same reason as packages |
| Database migrations | `packages/database/supabase/migrations/<timestamp>_saturn-<slug>.sql` | the `saturn-` slug makes fork migrations visible in `check-migrations.sh` output and in merges |
| Edge functions | `packages/database/supabase/functions/saturn-<name>/` | upstream never creates a `saturn-*` function |
| Deployment and operations | `contrib/deploying/gcp-tailscale/`, `contrib/deploying/knowledge/` | already fork-owned; private inputs stay in their ignored `.local/` |
| Sync tooling | `scripts/fork/`, `.github/workflows/{generated-files-drift,upstream-sync,resolve-sync-conflicts}.yml`, `docs/fork/` | the one sync mechanism |
| Agent records (plans, specs, lessons, decisions) | `.fork/` per `.fork/agent-policy.md` | upstream's `.ai/` churns on every sync |

Fork-owned code may import from upstream packages freely. Upstream code should
import from fork-owned code only through the hooks described next.

## 2. Shared upstream files get the minimal hook, nothing more

When fork code has to be reached from a shared file (a route registered in an
upstream barrel, a job added to the Inngest function list, an env var read by
`packages/env`, a nav entry), add the **smallest possible** hook — usually one
import and one line — and put the behaviour in a fork-owned file. Do not
reimplement, restyle or "improve" the surrounding upstream code in the same
change; that is what upstream is for (see §4).

Prefer existing extension points over new hooks: Inngest function registration,
the `x+` flat-route tree, workspace packages, `.env` configuration, Docker
`contrib/` overlays.

## 3. Every PR that touches a shared upstream file says why

A shared upstream file is any tracked file that exists in `upstream/main`. If your
PR modifies one, its description must contain a short section:

```
## Shared upstream files touched
- apps/erp/app/root.tsx — one-line hook to render the SOURCE_CODE_URL footer link;
  cannot live in a fork-owned file because root.tsx owns the public layout.
```

One line per file: what changed and why it cannot live in a fork-owned file.
"Could not find a better place" is an acceptable answer only together with a
follow-up (an upstream extension point, or an upstream PR).

## 4. Upstream anything generic

If a change would be useful to any Carbon install (a bug fix, a hardening, a
generic feature flag, a privacy-safe default), it belongs upstream. Open the
upstream PR from a branch cut off `upstream/main`:

```bash
bash scripts/fork/upstream-pr.sh feat/short-name <commit>...
```

Keep the fork's copy until the upstream release that contains it is merged, then
the sync removes the drift for free. `docs/fork/CUSTOMIZATIONS.md` §(b) tracks the
candidates.

## 5. Never hand-edit generated files

Files marked `merge=regen` in `.gitattributes` are outputs. Change their inputs
(migrations, service files, docs content, manifests) and run
`bash scripts/fork/regenerate.sh`. CI rejects a PR whose generated files do not
match their sources.

## 6. Never track these

Runtime and private artifacts must stay out of git even when a tool writes them
into the tree: `.env*` (except the `*.example` templates), `.local/`, `.secrets/`,
`secrets/`, `*.secret`, Terraform state/plans/provider downloads and `*.tfvars`,
Docker auth/cache/image exports, `__pycache__/`, `*.pyc`, `.cert/`,
`test-results/`, `playwright-report/`, `.fork/local/`, `.codex/`, and private
keys in any form. `.gitignore` already covers them; do not force-add. This list is
carried over from the retired tooling's `forbidden_tracked` registry because it
was the product of a real privacy audit.

## 7. Scripts and workflows

Shell scripts are bash with `set -euo pipefail`, executable, runnable from any
directory (`git rev-parse --show-toplevel`), and compatible with macOS's bash 3.2.
Workflows pin actions to a major version, use the least permissions that work, and
never push to `saturn/main`.
