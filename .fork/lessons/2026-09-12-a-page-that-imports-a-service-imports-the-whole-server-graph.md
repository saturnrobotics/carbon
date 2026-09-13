# A page that imports a service imports the whole server graph

Context → The Portal web app's Drive settings page took its eligibility label and its zod contract from `sources.service.ts`, the same module that forwards the loader's request. That service imports `intake.service.ts`, which imports `services/identity.server`. `pnpm --filter portal build` was green, so the leak looked absent.

Problem → React Router's `dot-server` plugin refuses a `.server` module reached from the client graph, and it was refusing this one — but only when the route was in the manifest. The route sat behind a build-time flag, so the default build compiled a manifest without it and reported success. The boundary was already broken and the only build anyone ran could not see it. A component needs one pure helper from a service and inherits every transitive import the service has; the service's own placement is irrelevant, because the value import is what pulls the graph.

Rule → Keep a page's contract and its pure descriptors in `{module}.models.ts`, whose imports must stay free of anything server-only, and let both the component and the service read them from there. Never re-export them from the service: a barrel hop re-creates the identical chain. When a surface is gated behind a build-time flag, run the build with the flag SET as part of verification and add that command to CI — and run it outside turbo, whose `build` task declares no `env` and will serve the flag-off artifact from cache.

Applies to → Every React Router app in this repo (`portal`, `erp`, `mes`, `academy`, `starter`); any `{module}.service.ts` that exports a schema, label, or formatter a component renders; and any feature whose routes are contributed conditionally at build time.
