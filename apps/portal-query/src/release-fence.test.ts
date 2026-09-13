import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "./index";

const { createReadHandler } = vi.hoisted(() => ({
  createReadHandler: vi.fn<
    (
      options: Record<string, unknown>
    ) => (request: Request) => Promise<Response>
  >(() => async () => Response.json({}))
}));
vi.mock("./query.server", () => ({ createReadHandler }));

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const workflow = ".github/workflows/portal-check.yml";

/**
 * Vector search and synthesis stay deferred until the provider-policy suites
 * are part of the manual profile's CI run. Each entry is a package the runtime
 * job tests with `pnpm --filter <name> test`, and the suite that run must list.
 */
const PROVIDER_POLICY_SUITES = {
  "@carbon/portal": {
    directory: "packages/portal",
    suite: "src/provider-policy.test.ts"
  },
  "portal-query": {
    directory: "apps/portal-query",
    suite: "src/provider-disclosure.test.ts"
  }
} as const;

const environment = {
  PORTAL_BUSINESS_TIMEZONE: "UTC",
  PORTAL_ORIGIN: "https://portal.example.com",
  PORTAL_READ_DATABASE_URL: "postgresql://unused@127.0.0.1:59999/unused",
  PORTAL_REDIS_URL: "redis://127.0.0.1:59998",
  PORTAL_RELEASE_PROFILE: "manual-v1",
  PORTAL_MANUAL_SOURCE_JSON: JSON.stringify({
    sourceId: "manuals",
    displayName: "Manual library"
  }),
  PORTAL_TRUSTED_CALLERS_JSON: JSON.stringify({
    version: 1,
    receiver: { id: "query", audience: "query-audience" },
    callers: [
      {
        callerId: "web",
        serviceAccountSubject: "web-subject",
        sourceIapAudience: "iap-audience",
        operations: ["portal.query"],
        capabilities: ["portal.read"],
        requiredAccessLevels: []
      }
    ]
  })
};

describe("provider release fence", () => {
  it("wires neither vector search nor synthesis under the manual profile, whatever provider configuration is present", () => {
    createReadHandler.mockClear();
    createHandler({
      ...environment,
      PORTAL_VERTEX_JSON: JSON.stringify({
        version: "v1",
        project: "synthetic-project",
        location: "us-central1",
        model: "synthetic-model-001",
        inputMicroUsdPerMillionTokens: 1,
        outputMicroUsdPerMillionTokens: 1
      }),
      PORTAL_EMBEDDING_JSON: JSON.stringify({
        version: "v1",
        project: "synthetic-project",
        location: "us-central1",
        model: "synthetic-embedding-001",
        microUsdPerMillionTokens: 1
      }),
      // A live-source registry is configuration the profile reads, not a
      // deferred provider; it is here to prove it does not drag one in.
      PORTAL_SOURCES_JSON: JSON.stringify({
        version: 1,
        sources: [
          {
            id: "carbon-source",
            kind: "carbon",
            origin: "https://erp.example",
            audience: "erp-receiver-audience"
          }
        ]
      })
    });
    expect(createReadHandler).toHaveBeenCalledTimes(1);
    const options = createReadHandler.mock.calls[0]?.[0];
    if (!options) throw Error("read handler was not created");
    expect(options.manualSourceId).toBe("manuals");
    for (const deferred of ["embedding", "model"])
      expect(options).not.toHaveProperty(deferred);
  });

  it("keeps every provider-policy suite inside the manual profile CI run", () => {
    const text = readFileSync(join(repositoryRoot, workflow), "utf8");
    const runtimeJob = text.slice(text.indexOf("\n  runtime:"));
    expect(runtimeJob.length).toBeGreaterThan(0);
    for (const [name, { directory, suite }] of Object.entries(
      PROVIDER_POLICY_SUITES
    )) {
      expect(runtimeJob).toMatch(
        new RegExp(`^\\s*corepack pnpm --filter ${name} test\\s*$`, "m")
      );
      const packageDirectory = join(repositoryRoot, directory);
      const scripts = JSON.parse(
        readFileSync(join(packageDirectory, "package.json"), "utf8")
      ).scripts as Record<string, string>;
      // The `test` script must select the default unit profile, so the listing
      // below is the profile CI actually runs.
      expect(scripts.test).toMatch(/^vitest run(?: |$)/);
      expect(scripts.test).not.toContain("--config");
      const listed = execFileSync(
        process.execPath,
        [
          join(packageDirectory, "node_modules/vitest/vitest.mjs"),
          "list",
          "--filesOnly"
        ],
        { cwd: packageDirectory, encoding: "utf8" }
      )
        .split("\n")
        .map((line) => line.trim());
      expect(listed).toContain(suite);
    }
  }, 60_000);
});
