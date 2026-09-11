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
 * The CLI in scripts/validate-callers.ts is a thin wrapper over this module.
 */
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
