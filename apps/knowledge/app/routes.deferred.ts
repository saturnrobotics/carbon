import { isDriveSurfaceEnabled } from "@carbon/knowledge/sources/drive-deployment";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { route } from "@react-router/dev/routes";

/**
 * Route surfaces the approved `manual-v1` release profile defers. `routes.ts`
 * is the production manifest and never names them; they reach it only when
 * `isDriveSurfaceEnabled` admits them, so a build whose environment does not
 * name `KNOWLEDGE_DRIVE_ENABLED=true` — every release image — produces a
 * manifest without them.
 *
 * This runs at build time, which is why the gate lives here rather than in the
 * page: an image built without the variable has no Drive route in its bundle
 * at all, so there is nothing a runtime environment can re-open. The page, its
 * service and its Playwright spec stay in the app and are exercisable whenever
 * the variable is set — `playwright.config.ts` sets it for the local harness
 * and `contrib/deploying/knowledge/compose.local.yaml` for the disposable
 * docker one.
 */
export function deferredDriveRoutes(
  environment: Record<string, string | undefined> = process.env
): RouteConfigEntry[] {
  if (!isDriveSurfaceEnabled(environment)) return [];
  return [route("settings/sources", "routes/settings.sources.tsx")];
}
