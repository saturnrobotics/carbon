/**
 * The Drive connector's portal surface is deferred from the approved
 * `manual-v1` release profile, which is read-only manual retrieval. Admitting
 * it is a release decision, so it is off unless a build environment names it
 * explicitly: only the exact string `true` is on, and unset, malformed and
 * "1"/"yes" values are all off.
 *
 * There is deliberately no companion "profile past manual-v1" condition of the
 * kind `isMcpEnabled` uses. MCP lives in a service that never reads the manual
 * source configuration; the web app does, and
 * `readManualSourceConfiguration` refuses any profile other than `manual-v1`,
 * so four of its routes throw under one. For this surface "profile past the
 * boundary" would mean "unreachable in every configuration that boots",
 * including the loopback e2e harness — a deferred surface that cannot be
 * exercised is an untested surface. The boundary is instead held by three
 * locks that do not depend on the app reading its own profile:
 *
 * 1. The web route manifest reads this at BUILD time
 *    (`apps/knowledge/app/routes.deferred.ts`). Every release image is built
 *    with the variable absent, so it ships no Drive route in its bundle at
 *    all — not a registered route that refuses at runtime. Setting the
 *    variable on a running revision cannot add a route to a bundle built
 *    without one.
 * 2. `contrib/deploying/knowledge/release.py` rejects any environment key
 *    absent from its `REQUIRED_ENVIRONMENT` set as deferred runtime
 *    configuration, so the variable cannot be declared on a deployed revision
 *    until that file is edited too.
 * 3. The same file pins `knowledge-web` to `manual-v1`, so the profile that
 *    defers this surface is the only one a release can carry.
 *
 * `contrib/deploying/knowledge/test_images.py` pins locks 1 and 2 by asserting
 * that no release Dockerfile and no `release.py` environment set names the
 * variable.
 */
export const DRIVE_SURFACE_ENABLED_VARIABLE = "KNOWLEDGE_DRIVE_ENABLED";

export function isDriveSurfaceEnabled(
  environment: Record<string, string | undefined>
): boolean {
  return environment[DRIVE_SURFACE_ENABLED_VARIABLE]?.trim() === "true";
}
