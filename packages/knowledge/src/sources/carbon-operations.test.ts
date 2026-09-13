import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CARBON_NON_OPERATION_PATHS,
  CARBON_OPERATION_NAME_PREFIX,
  CARBON_OPERATION_PATH_PREFIX,
  EXCLUDED_CARBON_OPERATIONS,
  REGISTERED_SOURCE_OPERATIONS
} from "./http.server";

/**
 * The transport's allowlist and Carbon's published operation set drifted apart
 * silently once: `getItemSupplierPricing` shipped with a capability, a
 * permission and a manifest entry, and no allowlist entry — so the only thing
 * it could return was the transport's own unregistered-operation refusal. The
 * capability worked, the permission worked, and nothing could reach it.
 *
 * Both sides are therefore READ here, never restated. The published set comes
 * from the committed manifest digest — the manifest itself is build output, so
 * the digest is the only committed record of what Carbon publishes — and the
 * registered set comes from the live allowlist. A second hand-written copy of
 * either would be the same defect wearing a different hat.
 */
const DIGEST_PATH = fileURLToPath(
  new URL(
    "../../../../apps/erp/app/routes/api+/mcp+/lib/tool-manifest.digest.json",
    import.meta.url
  )
);

type Digest = { tools: { name: string }[] };

function publishedKnowledgeOperations(): string[] {
  let raw: string;
  try {
    raw = readFileSync(DIGEST_PATH, "utf8");
  } catch (error) {
    // Never a skip. A drift test that quietly passes when it cannot read the
    // published set is exactly the silence it exists to break.
    throw new Error(
      `Cannot read the committed manifest digest at ${DIGEST_PATH}; run \`pnpm generate:mcp\`. (${String(error)})`
    );
  }
  const digest = JSON.parse(raw) as Digest;
  return digest.tools
    .map((tool) => tool.name)
    .filter((name) => name.startsWith(CARBON_OPERATION_NAME_PREFIX))
    .sort();
}

/** Carbon publishes `knowledge_getItemIdentity` at `/api/v1/knowledge/getItemIdentity`. */
function pathFor(operation: string): string {
  return `${CARBON_OPERATION_PATH_PREFIX}${operation.slice(CARBON_OPERATION_NAME_PREFIX.length)}`;
}

const published = publishedKnowledgeOperations();
const registeredCarbonPaths = [...REGISTERED_SOURCE_OPERATIONS]
  .filter((path) => path.startsWith(CARBON_OPERATION_PATH_PREFIX))
  .sort();

describe("Carbon knowledge operations reach the transport", () => {
  it("reads a non-empty published set, so a green run means something", () => {
    expect(published.length).toBeGreaterThan(0);
    expect(registeredCarbonPaths.length).toBeGreaterThan(0);
  });

  it("registers or deliberately excludes every operation Carbon publishes", () => {
    const unreachable = published.filter(
      (operation) =>
        !REGISTERED_SOURCE_OPERATIONS.has(pathFor(operation)) &&
        !Object.hasOwn(EXCLUDED_CARBON_OPERATIONS, operation)
    );
    expect(
      unreachable,
      `These knowledge operations are published by Carbon but neither registered in the transport allowlist nor listed in EXCLUDED_CARBON_OPERATIONS with a reason, so calling one returns an unregistered-operation refusal: ${unreachable.join(", ")}`
    ).toEqual([]);
  });

  it("gives every exclusion a stated reason", () => {
    for (const [operation, reason] of Object.entries(
      EXCLUDED_CARBON_OPERATIONS
    )) {
      expect(reason.trim().length, operation).toBeGreaterThan(20);
    }
  });

  it("excludes only operations Carbon actually publishes, and never one it registers", () => {
    for (const operation of Object.keys(EXCLUDED_CARBON_OPERATIONS)) {
      expect(published, operation).toContain(operation);
      expect(
        REGISTERED_SOURCE_OPERATIONS.has(pathFor(operation)),
        `${operation} is both registered and excluded`
      ).toBe(false);
    }
  });

  it("registers no Carbon path that is neither a published operation nor an explained route", () => {
    const publishedPaths = new Set(published.map(pathFor));
    const dead = registeredCarbonPaths.filter(
      (path) =>
        !publishedPaths.has(path) &&
        !Object.hasOwn(CARBON_NON_OPERATION_PATHS, path)
    );
    expect(
      dead,
      `These allowlist entries name no published operation, so they are dead — a typo looks exactly like a registration: ${dead.join(", ")}`
    ).toEqual([]);
    for (const [path, reason] of Object.entries(CARBON_NON_OPERATION_PATHS)) {
      expect(REGISTERED_SOURCE_OPERATIONS.has(path), path).toBe(true);
      expect(reason.trim().length, path).toBeGreaterThan(20);
    }
  });

  it("carries the supplier pricing read, the operation this test was written for", () => {
    expect(published).toContain("knowledge_getItemSupplierPricing");
    expect(
      REGISTERED_SOURCE_OPERATIONS.has(
        "/api/v1/knowledge/getItemSupplierPricing"
      )
    ).toBe(true);
  });
});
