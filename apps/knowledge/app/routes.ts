import type { RouteConfig } from "@react-router/dev/routes";
import { route } from "@react-router/dev/routes";

export default [
  route("", "routes/_index.tsx"),
  route("health", "routes/health.ts"),
  route("api/query", "routes/api.query.ts"),
  route("intake", "routes/intake.tsx"),
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
