/**
 * Pins the runtime zod schema and contrib/deploying/portal/callers.schema.json
 * to the same verdicts, so neither can drift from the other unnoticed, and
 * exercises the release validator the fork-checks workflow runs.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { trustedCallerConfigurationSchema } from "./identity.server";
import {
  CALLER_VALIDATION_USAGE,
  jsonSchemaIssues,
  runCallerValidation,
  TRUSTED_CALLERS_SCHEMA_PATH,
  validateCallerRegistry
} from "./trusted-callers";

const examplePath = resolve(
  TRUSTED_CALLERS_SCHEMA_PATH,
  "../callers.example.json"
);
const schema: unknown = JSON.parse(
  readFileSync(TRUSTED_CALLERS_SCHEMA_PATH, "utf8")
);
const example = JSON.parse(readFileSync(examplePath, "utf8")) as {
  version: number;
  receiver: Record<string, unknown>;
  callers: Record<string, unknown>[];
};

type Registry = typeof example;

function variant(mutate: (registry: Registry) => void): unknown {
  const copy = structuredClone(example);
  mutate(copy);
  return copy;
}

function callerAt(registry: Registry, index: number): Record<string, unknown> {
  const caller = registry.callers[index];
  if (!caller) throw new Error(`the example has no caller ${index}`);
  return caller;
}

function repeat<T>(value: T, count: number): T[] {
  return Array.from({ length: count }, () => structuredClone(value));
}

/** Expected verdicts. `runtime` is the zod schema, `schema` is callers.schema.json. */
const fixtures: {
  name: string;
  document: unknown;
  runtime: boolean;
  schema: boolean;
}[] = [
  {
    name: "the example registry",
    document: example,
    runtime: true,
    schema: true
  },
  {
    name: "a null document",
    document: null,
    runtime: false,
    schema: false
  },
  {
    name: "a missing version",
    document: variant((registry) => {
      delete (registry as Partial<Registry>).version;
    }),
    runtime: false,
    schema: false
  },
  {
    name: "version 2",
    document: variant((registry) => {
      registry.version = 2;
    }),
    runtime: false,
    schema: false
  },
  {
    name: "an unknown top-level key",
    document: variant((registry) => {
      (registry as Record<string, unknown>).comment = "x";
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a receiver without an audience",
    document: variant((registry) => {
      registry.receiver = { id: "portal-query" };
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a receiver with an unknown key",
    document: variant((registry) => {
      registry.receiver.region = "us-central1";
    }),
    runtime: false,
    schema: false
  },
  {
    name: "no callers",
    document: variant((registry) => {
      registry.callers = [];
    }),
    runtime: false,
    schema: false
  },
  {
    name: "callers that is not an array",
    document: variant((registry) => {
      (registry as Record<string, unknown>).callers = "portal-web";
    }),
    runtime: false,
    schema: false
  },
  {
    name: "101 callers",
    document: variant((registry) => {
      registry.callers = repeat(callerAt(registry, 0), 101).map(
        (caller, index) => ({
          ...caller,
          serviceAccountSubject: `1000000000000000${String(index).padStart(5, "0")}`
        })
      );
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a caller with an unknown key",
    document: variant((registry) => {
      callerAt(registry, 0).email = "workload@example.iam.gserviceaccount.com";
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a caller without requiredAccessLevels",
    document: variant((registry) => {
      delete callerAt(registry, 0).requiredAccessLevels;
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a caller with no operations",
    document: variant((registry) => {
      callerAt(registry, 0).operations = [];
    }),
    runtime: false,
    schema: false
  },
  {
    name: "101 operations",
    document: variant((registry) => {
      callerAt(registry, 0).operations = repeat("portal.query", 101);
    }),
    runtime: false,
    schema: false
  },
  {
    name: "101 capabilities",
    document: variant((registry) => {
      callerAt(registry, 0).capabilities = repeat("portal.read", 101);
    }),
    runtime: false,
    schema: false
  },
  {
    name: "21 required access levels",
    document: variant((registry) => {
      callerAt(registry, 0).requiredAccessLevels = repeat("level", 21);
    }),
    runtime: false,
    schema: false
  },
  {
    name: "an empty subject",
    document: variant((registry) => {
      callerAt(registry, 0).serviceAccountSubject = "";
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a whitespace-only subject",
    document: variant((registry) => {
      callerAt(registry, 0).serviceAccountSubject = "   ";
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a 2049-character audience",
    document: variant((registry) => {
      registry.receiver.audience = `https://${"a".repeat(2041)}`;
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a numeric operation",
    document: variant((registry) => {
      callerAt(registry, 0).operations = [42];
    }),
    runtime: false,
    schema: false
  },
  {
    name: "a duplicate service-account subject",
    document: variant((registry) => {
      callerAt(registry, 1).serviceAccountSubject = callerAt(
        registry,
        0
      ).serviceAccountSubject;
    }),
    // JSON Schema cannot express uniqueness across array items; the runtime
    // schema and validate-callers.ts both reject it.
    runtime: false,
    schema: true
  },
  {
    name: "a caller without assurance (defaults to carbon-mfa)",
    document: variant((registry) => {
      delete callerAt(registry, 0).assurance;
    }),
    runtime: true,
    schema: true
  },
  {
    name: "an explicit carbon-mfa assurance",
    document: variant((registry) => {
      callerAt(registry, 0).assurance = { mode: "carbon-mfa" };
    }),
    runtime: true,
    schema: true
  },
  {
    name: "a third assurance mode",
    document: variant((registry) => {
      callerAt(registry, 0).assurance = { mode: "iap-signature" };
    }),
    runtime: false,
    schema: false
  },
  {
    name: "workspace-equivalent without an access level",
    document: variant((registry) => {
      callerAt(registry, 0).assurance = { mode: "workspace-equivalent" };
    }),
    runtime: false,
    schema: false
  },
  {
    name: "workspace-equivalent with a whitespace access level",
    document: variant((registry) => {
      callerAt(registry, 0).assurance = {
        mode: "workspace-equivalent",
        accessLevel: "  "
      };
    }),
    runtime: false,
    schema: false
  },
  {
    name: "carbon-mfa with an access level",
    document: variant((registry) => {
      callerAt(registry, 0).assurance = {
        mode: "carbon-mfa",
        accessLevel: "accessPolicies/123456789012/accessLevels/workspace_2sv"
      };
    }),
    runtime: false,
    schema: false
  },
  {
    name: "an assurance with an unknown key",
    document: variant((registry) => {
      callerAt(registry, 0).assurance = {
        mode: "carbon-mfa",
        inferFromDomain: true
      };
    }),
    runtime: false,
    schema: false
  }
];

function runtimeAccepts(document: unknown): boolean {
  return trustedCallerConfigurationSchema.safeParse(document).success;
}

function schemaAccepts(document: unknown): boolean {
  return jsonSchemaIssues(schema, document).length === 0;
}

describe("trusted-caller registry schemas", () => {
  it.each(
    fixtures
  )("$name: runtime schema $runtime, callers.schema.json $schema", ({
    document,
    runtime,
    schema: expected
  }) => {
    expect(runtimeAccepts(document)).toBe(runtime);
    expect(schemaAccepts(document)).toBe(expected);
  });

  it("diverge only on subject uniqueness", () => {
    const divergent = fixtures
      .filter(
        ({ document }) => runtimeAccepts(document) !== schemaAccepts(document)
      )
      .map(({ name }) => name);
    expect(divergent).toEqual(["a duplicate service-account subject"]);
  });

  it("refuses a schema keyword outside the supported subset", () => {
    expect(() =>
      jsonSchemaIssues({ type: "string", format: "uri" }, "https://x")
    ).toThrow(/unsupported json schema keyword "format"/i);
    expect(() =>
      jsonSchemaIssues({ type: "object", additionalProperties: {} }, {})
    ).toThrow(/unsupported additionalProperties/i);
  });
});

describe("validate-callers", () => {
  it("accepts the example registry and lists every caller", () => {
    const report = validateCallerRegistry(example, schema);
    expect(report).toMatchObject({
      runtimeIssues: [],
      schemaIssues: [],
      releaseIssues: []
    });
    expect(report.summary).toEqual([
      "receiver portal-query: audience=https://portal-query.example.com",
      "caller portal-web: subject=100000000000000000001 iapAudience=/projects/123456789012/locations/us-central1/services/portal-web operations=portal.identity,portal.query capabilities=portal.read requiredAccessLevels=accessPolicies/123456789012/accessLevels/managed_device assurance=workspace-equivalent(accessPolicies/123456789012/accessLevels/workspace_2sv)",
      "caller portal-ingest: subject=100000000000000000002 iapAudience=/projects/123456789012/locations/us-central1/services/portal-web operations=portal.identity capabilities=portal.read,portal.intake.capture,portal.intake.review,portal.intake.publish,portal.document.delete,portal.document.download requiredAccessLevels=accessPolicies/123456789012/accessLevels/managed_device assurance=carbon-mfa"
    ]);
  });

  it("reports the default assurance for a caller that omits it", () => {
    const report = validateCallerRegistry(
      variant((registry) => {
        delete callerAt(registry, 1).assurance;
      }),
      schema
    );
    expect(report.runtimeIssues).toEqual([]);
    expect(report.schemaIssues).toEqual([]);
    expect(report.summary[2]).toMatch(/ assurance=carbon-mfa$/);
  });

  it("names the assurance branch that failed", () => {
    const report = validateCallerRegistry(
      variant((registry) => {
        callerAt(registry, 0).assurance = { mode: "workspace-equivalent" };
      }),
      schema
    );
    expect(report.runtimeIssues.length).toBeGreaterThan(0);
    expect(report.schemaIssues).toEqual([
      "$.callers[0].assurance: must match exactly one of 2 schemas (matched 0)"
    ]);
  });

  it("rejects a duplicate subject", () => {
    const report = validateCallerRegistry(
      variant((registry) => {
        callerAt(registry, 1).serviceAccountSubject = callerAt(
          registry,
          0
        ).serviceAccountSubject;
      }),
      schema
    );
    expect(report.runtimeIssues).toEqual([
      "$.callers.1.serviceAccountSubject: Service-account subjects must be unique"
    ]);
    expect(report.summary).toEqual([]);
  });

  it.each([
    ["an http receiver audience", "http://portal-query.example.com"],
    [
      "a receiver audience with a query",
      "https://portal-query.example.com/?x=1"
    ],
    [
      "a receiver audience with credentials",
      "https://user:pw@portal-query.example.com"
    ],
    ["a plain-label receiver audience", "e2e-query"]
  ])("rejects %s as a release rule only", (_name, audience) => {
    const report = validateCallerRegistry(
      variant((registry) => {
        registry.receiver.audience = audience;
      }),
      schema
    );
    expect(report.runtimeIssues).toEqual([]);
    expect(report.schemaIssues).toEqual([]);
    expect(report.releaseIssues).toEqual([
      "$.receiver.audience: must be a bare https URL (no credentials, query or fragment)"
    ]);
  });

  it("rejects an email-shaped subject and a bare IAP audience as release rules", () => {
    const report = validateCallerRegistry(
      variant((registry) => {
        callerAt(registry, 0).serviceAccountSubject =
          "workload@example.iam.gserviceaccount.com";
        callerAt(registry, 1).sourceIapAudience = "portal-web";
      }),
      schema
    );
    expect(report.releaseIssues).toEqual([
      "$.callers[0].serviceAccountSubject: must be the service account's numeric unique ID, never its email",
      "$.callers[1].sourceIapAudience: must be an IAP resource path starting with /projects/"
    ]);
  });

  it("reports shape violations from both schemas", () => {
    const report = validateCallerRegistry(
      variant((registry) => {
        callerAt(registry, 0).operations = [];
        (registry as Record<string, unknown>).comment = "x";
      }),
      schema
    );
    expect(report.runtimeIssues.length).toBeGreaterThan(0);
    expect(report.schemaIssues).toEqual([
      "$.callers[0].operations: must have at least 1 items",
      '$: unexpected property "comment"'
    ]);
    expect(report.releaseIssues).toEqual([]);
  });
});

const DUPLICATE_SUBJECT_ISSUE =
  "runtime schema: $.callers.1.serviceAccountSubject: Service-account subjects must be unique";

/**
 * The CLI layer: argument handling, the printed report and the exit code.
 *
 * Every case but the last calls runCallerValidation in the runtime vitest has
 * already loaded. Driving each one through `tsx scripts/validate-callers.ts`
 * instead cost 181-189 ms per spawn here and ~3.6 s per spawn on a CI runner,
 * where the four spawns this used to make took 14.4 s against the 5 s default
 * timeout. Almost all of that is the TypeScript loader starting up — `tsx -e 0`
 * alone is 153-180 ms against node's 18 ms — so it bought a second copy of
 * nothing: the validation itself runs in under 2 ms.
 */
describe("validate-callers from the command line", () => {
  const packageDirectory = resolve(import.meta.dirname, "..");
  const scratch = mkdtempSync(join(tmpdir(), "callers-"));

  function writeRegistry(name: string, document: unknown): string {
    const path = join(scratch, name);
    writeFileSync(path, JSON.stringify(document));
    return path;
  }

  const duplicatePath = writeRegistry(
    "duplicate.json",
    variant((registry) => {
      callerAt(registry, 1).serviceAccountSubject = callerAt(
        registry,
        0
      ).serviceAccountSubject;
    })
  );
  const insecurePath = writeRegistry(
    "insecure.json",
    variant((registry) => {
      registry.receiver.audience = "http://portal-query.example.com";
    })
  );

  async function run(...args: string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const status = await runCallerValidation(
      args,
      {
        print: (line) => {
          stdout.push(line);
        },
        fail: (line) => {
          stderr.push(line);
        }
      },
      packageDirectory
    );
    return { status, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
  }

  it("exits 0 for the example registry", async () => {
    const accepted = await run(examplePath);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("caller portal-web:");
    expect(accepted.stdout).toContain("conforms to the runtime schema");
  });

  it("exits 1 for a duplicate subject", async () => {
    const duplicate = await run(duplicatePath);
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain(DUPLICATE_SUBJECT_ISSUE);
  });

  it("exits 1 for an http receiver audience", async () => {
    const insecure = await run(insecurePath);
    expect(insecure.status).toBe(1);
    expect(insecure.stderr).toContain(
      "release rule: $.receiver.audience: must be a bare https URL"
    );
  });

  it("exits 2 without a registry file", async () => {
    const usage = await run();
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain(CALLER_VALIDATION_USAGE);
  });

  /**
   * The one process-level case, and the only one that pays the loader: it
   * proves the line the calls above cannot reach, that runCallerValidation's
   * return value becomes the process's exit status. A REJECTED registry is
   * what proves it. This validator is a release gate, so the regression that
   * matters is one that exits 0 on a registry it should refuse — an exit-0
   * expectation passes straight through that, and only a non-zero one catches
   * it. The example's exit 0 through this same entry point is what
   * fork-checks.yml runs (`callers:validate callers.example.json`) on every
   * change to the validator.
   *
   * The timeout is explicit because one loader start-up is the floor for any
   * process-level case and ~3.6 s of it on a CI runner leaves too little room
   * under the 5 s default; 10 s is roughly triple the measured cost and still
   * fails if this ever grows a second spawn.
   */
  it("exits non-zero from the real entry point", { timeout: 10_000 }, () => {
    const spawned = spawnSync(
      resolve(packageDirectory, "node_modules/.bin/tsx"),
      [resolve(packageDirectory, "scripts/validate-callers.ts"), duplicatePath],
      { cwd: packageDirectory, encoding: "utf8" }
    );
    expect(spawned.status, spawned.stderr).toBe(1);
    expect(spawned.stderr).toContain(DUPLICATE_SUBJECT_ISSUE);
  });
});
