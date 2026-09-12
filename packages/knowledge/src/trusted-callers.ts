/**
 * Release-time validation of a trusted-caller registry (the value of
 * KNOWLEDGE_TRUSTED_CALLERS_JSON). Three verdicts, all of which must pass:
 *
 * 1. the runtime zod schema every receiver parses the value with;
 * 2. the published JSON Schema, contrib/deploying/knowledge/callers.schema.json;
 * 3. release rules the runtime leaves open so local fixtures can use plain
 *    labels: an https receiver audience, numeric service-account subjects and
 *    `/projects/...` IAP audiences.
 *
 * The CLI in scripts/validate-callers.ts is a thin wrapper over this module:
 * runCallerValidation below is the whole of it apart from the process wiring,
 * so its argument handling, report and exit codes are covered without spawning
 * the TypeScript loader.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isServiceAudience,
  type TrustedCallerConfiguration,
  trustedCallerConfigurationSchema
} from "./identity.server";

export const TRUSTED_CALLERS_SCHEMA_PATH = resolve(
  import.meta.dirname,
  "../../../contrib/deploying/knowledge/callers.schema.json"
);

type JsonObject = Record<string, unknown>;

const ANNOTATION_KEYWORDS = new Set([
  "$schema",
  "$id",
  "title",
  "description",
  "$defs"
]);
const SUPPORTED_KEYWORDS = new Set([
  ...ANNOTATION_KEYWORDS,
  "$ref",
  "type",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "pattern"
]);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asSchema(value: unknown, path: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`Unsupported JSON Schema at ${path}: expected an object`);
  }
  return value;
}

function resolveReference(root: JsonObject, reference: string): JsonObject {
  const prefix = "#/$defs/";
  if (!reference.startsWith(prefix)) {
    throw new Error(`Unsupported $ref "${reference}"; only #/$defs/* is read`);
  }
  const name = reference.slice(prefix.length);
  const definitions = isJsonObject(root.$defs) ? root.$defs : {};
  return asSchema(definitions[name], `#/$defs/${name}`);
}

function hasType(value: unknown, type: string, path: string): boolean {
  switch (type) {
    case "object":
      return isJsonObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    default:
      throw new Error(`Unsupported JSON Schema type "${type}" at ${path}`);
  }
}

/**
 * Validates `value` against the subset of JSON Schema 2020-12 that
 * callers.schema.json uses. A keyword outside the subset throws rather than
 * being ignored, so the schema cannot grow a constraint this check would
 * silently skip. Returns one message per violation; empty means valid.
 */
export function jsonSchemaIssues(
  schema: unknown,
  value: unknown,
  root: unknown = schema,
  path = "$"
): string[] {
  const node = asSchema(schema, path);
  const rootNode = asSchema(root, "#");
  for (const keyword of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new Error(
        `Unsupported JSON Schema keyword "${keyword}" at ${path}; extend trusted-callers.ts before using it`
      );
    }
  }
  if (typeof node.$ref === "string") {
    return jsonSchemaIssues(
      resolveReference(rootNode, node.$ref),
      value,
      rootNode,
      path
    );
  }

  const issues: string[] = [];
  if ("const" in node) {
    if (isJsonObject(node.const) || Array.isArray(node.const)) {
      throw new Error(`Unsupported non-primitive const at ${path}`);
    }
    if (!Object.is(node.const, value)) {
      issues.push(`${path}: must equal ${JSON.stringify(node.const)}`);
    }
  }
  if (typeof node.type === "string" && !hasType(value, node.type, path)) {
    issues.push(`${path}: must be ${node.type}`);
    return issues;
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof node.minLength === "number" && length < node.minLength) {
      issues.push(`${path}: must be at least ${node.minLength} characters`);
    }
    if (typeof node.maxLength === "number" && length > node.maxLength) {
      issues.push(`${path}: must be at most ${node.maxLength} characters`);
    }
    if (
      typeof node.pattern === "string" &&
      !new RegExp(node.pattern, "u").test(value)
    ) {
      issues.push(`${path}: must match ${node.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      issues.push(`${path}: must have at least ${node.minItems} items`);
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      issues.push(`${path}: must have at most ${node.maxItems} items`);
    }
    if (node.items !== undefined) {
      value.forEach((item, index) => {
        issues.push(
          ...jsonSchemaIssues(node.items, item, rootNode, `${path}[${index}]`)
        );
      });
    }
  }

  if (isJsonObject(value)) {
    const properties = isJsonObject(node.properties) ? node.properties : {};
    if (Array.isArray(node.required)) {
      for (const name of node.required) {
        if (typeof name === "string" && !(name in value)) {
          issues.push(`${path}: missing required property "${name}"`);
        }
      }
    }
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (name in value) {
        issues.push(
          ...jsonSchemaIssues(
            propertySchema,
            value[name],
            rootNode,
            `${path}.${name}`
          )
        );
      }
    }
    if (node.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in properties)) {
          issues.push(`${path}: unexpected property "${name}"`);
        }
      }
    } else if (node.additionalProperties !== undefined) {
      throw new Error(
        `Unsupported additionalProperties at ${path}; only false is read`
      );
    }
  }

  return issues;
}

/**
 * Rules a released registry must satisfy on top of the shape. The runtime
 * schema does not enforce them because the local Docker fixtures use plain
 * labels such as "e2e-query" for audiences and subjects.
 */
export function releaseIssues(
  configuration: TrustedCallerConfiguration
): string[] {
  const issues: string[] = [];
  if (!isServiceAudience(configuration.receiver.audience)) {
    issues.push(
      "$.receiver.audience: must be a bare https URL (no credentials, query or fragment)"
    );
  }
  configuration.callers.forEach((caller, index) => {
    if (!/^\d+$/.test(caller.serviceAccountSubject)) {
      issues.push(
        `$.callers[${index}].serviceAccountSubject: must be the service account's numeric unique ID, never its email`
      );
    }
    if (!caller.sourceIapAudience.startsWith("/projects/")) {
      issues.push(
        `$.callers[${index}].sourceIapAudience: must be an IAP resource path starting with /projects/`
      );
    }
  });
  return issues;
}

export interface RegistryReport {
  /** Violations of the runtime zod schema; `$.path: message`. */
  runtimeIssues: string[];
  /** Violations of callers.schema.json. */
  schemaIssues: string[];
  /** Violations of the release rules; only computed once the shape is valid. */
  releaseIssues: string[];
  /** One printable line for the receiver and for each caller. */
  summary: string[];
}

export function validateCallerRegistry(
  document: unknown,
  schema: unknown
): RegistryReport {
  const parsed = trustedCallerConfigurationSchema.safeParse(document);
  const runtimeIssues = parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `$.${issue.path.join(".")}: ${issue.message}`
      );
  const schemaIssues = jsonSchemaIssues(schema, document);
  const summary: string[] = [];
  if (parsed.success) {
    const { receiver, callers } = parsed.data;
    summary.push(`receiver ${receiver.id}: audience=${receiver.audience}`);
    for (const caller of callers) {
      summary.push(
        `caller ${caller.callerId}: subject=${caller.serviceAccountSubject} iapAudience=${caller.sourceIapAudience} operations=${caller.operations.join(",")} capabilities=${caller.capabilities.join(",") || "-"} requiredAccessLevels=${caller.requiredAccessLevels.join(",") || "-"}`
      );
    }
  }
  return {
    runtimeIssues,
    schemaIssues,
    releaseIssues: parsed.success ? releaseIssues(parsed.data) : [],
    summary
  };
}

/**
 * Where the CLI writes its report. Injected so the argument handling, the
 * printed lines and the exit code can be exercised in the caller's own
 * runtime; only scripts/validate-callers.ts binds it to the process streams.
 */
export interface CallerValidationOutput {
  print: (line: string) => void;
  fail: (line: string) => void;
}

export const CALLER_VALIDATION_USAGE =
  "usage: callers:validate <registry.json> [--schema <callers.schema.json>]";

/**
 * The CLI apart from its process wiring: reads the registry and schema named
 * by `argv`, writes the report to `output`, and returns the exit code — 0 when
 * the registry is clean, 1 on any issue, 2 on a usage error. Relative
 * arguments resolve against `base`, which the caller supplies because where a
 * repo-relative path points is a property of how the process was launched.
 */
export async function runCallerValidation(
  argv: readonly string[],
  output: CallerValidationOutput,
  base: string
): Promise<number> {
  const remaining = [...argv];
  const files: string[] = [];
  let schemaPath = TRUSTED_CALLERS_SCHEMA_PATH;
  while (remaining.length > 0) {
    const argument = remaining.shift() as string;
    if (argument === "--schema") {
      const value = remaining.shift();
      if (!value) {
        output.fail(CALLER_VALIDATION_USAGE);
        return 2;
      }
      schemaPath = resolve(base, value);
    } else {
      files.push(argument);
    }
  }
  const [registryFile] = files;
  if (files.length !== 1 || !registryFile) {
    output.fail(CALLER_VALIDATION_USAGE);
    return 2;
  }
  const registryPath = resolve(base, registryFile);
  const document: unknown = JSON.parse(await readFile(registryPath, "utf8"));
  const schema: unknown = JSON.parse(await readFile(schemaPath, "utf8"));
  const report = validateCallerRegistry(document, schema);
  for (const line of report.summary) output.print(line);
  const failures = [
    ...report.runtimeIssues.map((issue) => `runtime schema: ${issue}`),
    ...report.schemaIssues.map((issue) => `callers.schema.json: ${issue}`),
    ...report.releaseIssues.map((issue) => `release rule: ${issue}`)
  ];
  if (failures.length > 0) {
    for (const failure of failures) output.fail(failure);
    output.fail(`${registryPath}: ${failures.length} issue(s)`);
    return 1;
  }
  output.print(
    `${registryPath}: conforms to the runtime schema, ${schemaPath} and the release rules`
  );
  return 0;
}
