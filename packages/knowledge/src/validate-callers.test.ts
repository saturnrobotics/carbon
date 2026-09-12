/**
 * Pins the runtime zod schema and contrib/deploying/knowledge/callers.schema.json
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
  jsonSchemaIssues,
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
      registry.receiver = { id: "knowledge-query" };
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
      (registry as Record<string, unknown>).callers = "knowledge-web";
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
      callerAt(registry, 0).operations = repeat("knowledge.query", 101);
    }),
    runtime: false,
    schema: false
  },
  {
    name: "101 capabilities",
    document: variant((registry) => {
      callerAt(registry, 0).capabilities = repeat("knowledge.read", 101);
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
      "receiver knowledge-query: audience=https://knowledge-query.example.com",
      "caller knowledge-web: subject=100000000000000000001 iapAudience=/projects/123456789012/locations/us-central1/services/knowledge-web operations=knowledge.identity,knowledge.query capabilities=knowledge.read requiredAccessLevels=accessPolicies/123456789012/accessLevels/managed_device assurance=workspace-equivalent(accessPolicies/123456789012/accessLevels/workspace_2sv)",
      "caller knowledge-ingest: subject=100000000000000000002 iapAudience=/projects/123456789012/locations/us-central1/services/knowledge-web operations=knowledge.identity capabilities=knowledge.read,knowledge.intake.capture,knowledge.intake.review,knowledge.intake.publish,knowledge.document.delete,knowledge.document.download requiredAccessLevels=accessPolicies/123456789012/accessLevels/managed_device assurance=carbon-mfa"
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
    ["an http receiver audience", "http://knowledge-query.example.com"],
    [
      "a receiver audience with a query",
      "https://knowledge-query.example.com/?x=1"
    ],
    [
      "a receiver audience with credentials",
      "https://user:pw@knowledge-query.example.com"
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
        callerAt(registry, 1).sourceIapAudience = "knowledge-web";
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

  it("exits 0 for the example and 1 for rejected registries from the command line", () => {
    const packageDirectory = resolve(import.meta.dirname, "..");
    const tsx = resolve(packageDirectory, "node_modules/.bin/tsx");
    const script = resolve(packageDirectory, "scripts/validate-callers.ts");
    const scratch = mkdtempSync(join(tmpdir(), "callers-"));
    const run = (...args: string[]) =>
      spawnSync(tsx, [script, ...args], {
        cwd: packageDirectory,
        encoding: "utf8"
      });
    const writeRegistry = (name: string, document: unknown) => {
      const path = join(scratch, name);
      writeFileSync(path, JSON.stringify(document));
      return path;
    };

    const accepted = run(examplePath);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain("caller knowledge-web:");
    expect(accepted.stdout).toContain("conforms to the runtime schema");

    const duplicate = run(
      writeRegistry(
        "duplicate.json",
        variant((registry) => {
          callerAt(registry, 1).serviceAccountSubject = callerAt(
            registry,
            0
          ).serviceAccountSubject;
        })
      )
    );
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain(
      "runtime schema: $.callers.1.serviceAccountSubject: Service-account subjects must be unique"
    );

    const insecure = run(
      writeRegistry(
        "insecure.json",
        variant((registry) => {
          registry.receiver.audience = "http://knowledge-query.example.com";
        })
      )
    );
    expect(insecure.status).toBe(1);
    expect(insecure.stderr).toContain(
      "release rule: $.receiver.audience: must be a bare https URL"
    );

    expect(run().status).toBe(2);
  });
});
