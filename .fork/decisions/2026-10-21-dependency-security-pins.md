# Dependency security pins: sharp 0.35.5 and the audit's fixable findings

Base: `saturn/main` at `924ad0b205`. This fixes GHSA-wq5f-xc86-pv6w
(CVE-2026-96889: librsvg as bundled by sharp, fixed in sharp 0.35.5), along with
every other critical and high `pnpm audit --prod` finding the fork can fix
without adding cost to upstream syncs.

## Where the pins live

The fork has no place of its own for dependency overrides. pnpm reads
`overrides` only from `pnpm-workspace.yaml` or the root `package.json`, and
upstream owns both. A `.pnpmfile.cjs` hook would add a second mechanism, change
the lockfile's `pnpmfileChecksum` and add a Docker build input. Upstream already
keeps a block of security pins in `pnpm-workspace.yaml`, so this change uses
that block, under two rules:

- **Raise only pins that already exist, to upstream `main`'s values** (as of
  `1221665cc2`; the values came from upstream #1940). No override line was added.
  - `sharp` 0.35.0 → 0.35.5
  - `next@15` 15.5.21 → 15.5.27; `next@16` 16.2.11 → 16.3.8
  - `@grpc/grpc-js` 1.14.4 → 1.14.5
  - `axios` 1.16.0 → 1.20.0 (override and catalog)
  - `brace-expansion@1/2/5` → 1.1.21 / 2.1.7 / 5.0.12
  - `fast-uri` 3.1.5 → 3.1.8 (override and the root `package.json` dependency)
  - `js-yaml` 4.3.1 → 4.3.2
  - `shell-quote` 1.9.0 → 1.11.0
- **Refresh other packages in the lockfile only, within their existing
  ranges:** proxy-addr 2.0.8, compression 1.8.2, browserslist 4.28.7,
  markdown-it 14.3.3, follow-redirects 1.16.1, source-map-js 1.2.2 and undici
  8.10.2. prosemirror-view moved to 1.42.6 together with prosemirror-model
  1.25.12, keeping a single model copy (the pairing upstream uses). pnpm 10.33's
  `update` does not move transitive packages, so the refresh used temporary
  overrides: add them, install, remove them, install again. The committed
  lockfile's `overrides` section holds only the committed pins, and
  `pnpm install --frozen-lockfile` accepts it.

On the next sync, take upstream's lines for all of these; every fork value
equals upstream's. The `regen` driver takes upstream's lockfile, which drops the
lockfile-only refreshes. Upstream's lockfile still resolves follow-redirects
1.16.0 and markdown-it 14.3.2, both below the fixes, so after the sync run
`pnpm audit --prod` and refresh those two again.

## sharp in this tree

No Carbon code imports sharp. It is Next's optional dependency and arrives three ways:

- **The docs site:** Next 16, whose image optimizer refuses SVG by default.
- **ERP, MES, `@carbon/auth`, `@carbon/jobs`, `@carbon/lib` and portal-worker:**
  `next@15`, installed automatically as an optional peer of `@vercel/analytics`
  and `inngest`. ERP and MES import only `@vercel/analytics/react`, so Next is
  never loaded. The prebuilt binaries are still copied into their images.
- **`@react-email/preview-server`:** a development tool.

No untrusted SVG reaches sharp:
- Uploads go to Supabase Storage with image transformation off.
- The thumbnail function rasterizes a Chromium screenshot with ImageMagick WASM.
- Invoice intake decodes only PNG, JPEG and WebP, with `@napi-rs/canvas`.

## Audit

| `pnpm audit` | critical | high | moderate | low |
| --- | --- | --- | --- | --- |
| `--prod`, before | 6 | 50 | 116 | 26 |
| `--prod`, after | 0 | 15 | 89 | 21 |
| full tree, before | 9 | 54 | 143 | 33 |
| full tree, after | 0 | 20 | 117 | 28 |

Left open, with reasons:

- **`@modelcontextprotocol/sdk` 1.29.0** (3 high, fixed in 1.32.0). It is an
  exact pin in `apps/erp/package.json`. Upstream removed the SDK, so bumping it
  here would conflict on the next sync. The ERP MCP route authenticates the
  caller (OAuth token or API key, rate limited) before the SDK sees the
  request. Experimental tasks and the SDK's OAuth client are not used.
- **nodemailer 9.0.1** (2 high, quadratic address parsing). It is an exact pin
  in `packages/ee` and `packages/jobs`. 9.1.0 fixes one finding; the other needs
  10.0.6, a new major. Upstream has 9.1.1 in `ee` and dropped it from `jobs`.
- **react-router 7.18.0** (high). It affects only the unstable RSC mode, which
  Carbon does not use. Upstream is on 7.18.4.
- **tar 7.5.19** (high). Upstream's own pin holds it there. It is reached
  through the Supabase CLI and removed from the runtime images.
- **vite 7.3.5 / 8.0.16** (high). The bug is a Windows-only dev-server check,
  not used in production. Upstream has vite 8.3.1; `vite@7` is still 7.3.5.
- **braces 3.0.3** (high). No fixed release exists; it is build tooling only.

## Verification

- `pnpm install --frozen-lockfile` passes, and the lockfile diff moves only the
  packages above (plus caniuse data that browserslist needs).
- Docs `next build` succeeds on Next 16.3.8 with the existing Lingui SWC plugin.
- Passing:
  - `pnpm exec biome check`
  - `pnpm --filter @carbon/harness gates` (lint, conformance, clobbers)
  - `pnpm run typegen` and `turbo run typecheck --filter='*'`
  - `pnpm test`
  - The deployment tooling suite on Python 3.12 with PyYAML 6.0.2 and ruff
    0.4.1.
- Database-derived generated files are left to the `generated-files-drift`
  check. No migration or generator input other than the lockfile changed.
