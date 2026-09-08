import type { ManifestEntry } from "@carbon/api";
import { describe, expect, it } from "vitest";
import type { AuthedContext } from "./base.server";
import { assertWorkforceAuthorization } from "./base.server";

function context(
  overrides: Partial<NonNullable<AuthedContext["workforce"]>> = {}
): AuthedContext {
  return {
    client: {} as never,
    userId: "usr_existing",
    companyId: "cmp_alpha",
    companyGroupId: "grp_alpha",
    authKind: "workforce",
    scopes: {},
    workforce: {
      allowedOperations: ["knowledge_getItemIdentity"],
      capabilities: ["knowledge.read"],
      permissions: {
        parts: {
          view: ["cmp_alpha"],
          create: [],
          update: [],
          delete: []
        }
      },
      policyVersion: "identity-2:permission-4",
      ...overrides
    }
  };
}

const itemIdentity = {
  name: "knowledge_getItemIdentity",
  module: "knowledge",
  permission: { module: "parts", actions: ["view"] }
} as ManifestEntry;

describe("workforce operation authorization", () => {
  it("requires the exact caller operation, capability, and current permission", () => {
    expect(() =>
      assertWorkforceAuthorization(context(), itemIdentity)
    ).not.toThrow();
  });

  it.each([
    ["operation", { allowedOperations: [] }],
    ["capability", { capabilities: [] }],
    [
      "current permission",
      {
        permissions: {
          parts: { view: [], create: [], update: [], delete: [] }
        }
      }
    ]
  ])("denies missing %s", (_name, override) => {
    expect(() =>
      assertWorkforceAuthorization(context(override), itemIdentity)
    ).toThrow();
  });

  it("denies arbitrary generated operation names", () => {
    expect(() =>
      assertWorkforceAuthorization(context(), {
        ...itemIdentity,
        name: "knowledge_updateItem"
      })
    ).toThrow();
  });

  it("requires the dedicated procurement capability and purchasing-create permission", () => {
    const procurement = {
      name: "knowledge_createProcurementDraft",
      module: "knowledge",
      permission: { module: "purchasing", actions: ["create"] }
    } as ManifestEntry;
    expect(() =>
      assertWorkforceAuthorization(
        context({
          allowedOperations: ["knowledge_createProcurementDraft"],
          capabilities: ["carbon.procurement.draft"],
          permissions: {
            purchasing: {
              view: [],
              create: ["cmp_alpha"],
              update: [],
              delete: []
            }
          }
        }),
        procurement
      )
    ).not.toThrow();
    expect(() =>
      assertWorkforceAuthorization(
        context({
          allowedOperations: ["knowledge_createProcurementDraft"],
          capabilities: ["carbon.procurement.draft"],
          permissions: {
            purchasing: { view: [], create: [], update: [], delete: [] }
          }
        }),
        procurement
      )
    ).toThrow();
  });
});
