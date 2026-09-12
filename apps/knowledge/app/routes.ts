import type { RouteConfig } from "@react-router/dev/routes";
import { route } from "@react-router/dev/routes";
import { deferredDriveRoutes } from "./routes.deferred";

/** The production manifest. Surfaces the approved `manual-v1` release profile
 * defers are not named here — they reach the manifest only through the
 * build-time gate in `routes.deferred.ts`, which is off by default. */
export default [
  route("", "routes/_index.tsx"),
  route("health", "routes/health.ts"),
  route("logout", "routes/logout.ts"),
  route("api/query", "routes/api.query.ts"),
  route("intake", "routes/intake.tsx"),
  ...deferredDriveRoutes(),
  route("intake/:id", "routes/intake.$id.tsx"),
  route(
    "documents/:documentId/versions/:versionId",
    "routes/documents.$documentId.versions.$versionId.ts"
  ),
  route(
    "documents/:documentId/remove",
    "routes/documents.$documentId.remove.tsx"
  ),
  route("*", "routes/unavailable.tsx")
] satisfies RouteConfig;
