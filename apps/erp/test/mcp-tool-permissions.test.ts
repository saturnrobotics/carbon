import { describe, expect, it } from "vitest";
import metadata from "../app/routes/api+/mcp+/lib/tool-metadata.json";

// Pins the permission-derivation rules in scripts/lib/service-metadata.ts
// (derivePermission + permissionActionsFor) against the REAL generated manifest.
// These permissions gate every API-key call at the oRPC layer, so a generator
// change that silently re-derives them is an authorization change — it must fail
// here first.

type Tool = {
  name: string;
  module: string;
  classification: "READ" | "WRITE" | "DESTRUCTIVE";
  permission: { module: string | null; actions: string[] };
};

const allTools = metadata.tools as Tool[];

// PERMISSION_OVERRIDES in scripts/lib/service-metadata.ts — route-verified
// exceptions that win over the derivation rules. Pinned exactly below and
// excluded from the rule-based assertions.
const EXPECTED_OVERRIDES: Record<string, Tool["permission"]> = {
  settings_getApiKeys: { module: "users", actions: ["update"] },
  settings_upsertApiKey: { module: "users", actions: ["update"] },
  settings_deleteApiKey: { module: "users", actions: ["update"] },
  knowledge_resolveItems: { module: "parts", actions: ["view"] },
  knowledge_getItemIdentity: { module: "parts", actions: ["view"] },
  knowledge_getDocumentReferences: { module: "parts", actions: ["view"] },
  knowledge_getRecentReceipts: { module: "inventory", actions: ["view"] },
  knowledge_getRecentReceiptItems: { module: "inventory", actions: ["view"] },
  knowledge_getPurchaseStatus: { module: "purchasing", actions: ["view"] },
  knowledge_createProcurementDraft: {
    module: "purchasing",
    actions: ["create"]
  }
};

const tools = allTools.filter(
  (t) => !Object.hasOwn(EXPECTED_OVERRIDES, t.name)
);

const funcName = (t: Tool) => t.name.slice(t.module.length + 1).toLowerCase();

describe("permission overrides", () => {
  it.each(
    Object.entries(EXPECTED_OVERRIDES)
  )("%s keeps its explicit permission gate", (name, permission) => {
    const t = allTools.find((t) => t.name === name);
    expect(t, name).toBeDefined();
    expect(t?.permission, name).toEqual(permission);
  });
});

describe("permission module mapping", () => {
  it("maps items_* to the 'parts' permission module", () => {
    for (const t of tools.filter((t) => t.module === "items")) {
      expect(t.permission.module, t.name).toBe("parts");
    }
  });

  it("maps account_* and shared_* to null (valid-key-of-company gate only)", () => {
    for (const t of tools.filter(
      (t) => t.module === "account" || t.module === "shared"
    )) {
      expect(t.permission.module, t.name).toBeNull();
    }
  });

  it("maps every other module to itself", () => {
    for (const t of tools.filter(
      (t) => !["items", "account", "shared"].includes(t.module)
    )) {
      expect(t.permission.module, t.name).toBe(t.module);
    }
  });
});

describe("permission action derivation", () => {
  it("every READ op gates on view only", () => {
    for (const t of tools.filter((t) => t.classification === "READ")) {
      expect(t.permission.actions, t.name).toEqual(["view"]);
    }
  });

  it("every delete* op gates on delete", () => {
    for (const t of tools.filter(
      (t) => t.classification !== "READ" && funcName(t).startsWith("delete")
    )) {
      expect(t.permission.actions, t.name).toEqual(["delete"]);
    }
  });

  it("every upsert* op gates on create AND update (open question 2 in the parent plan — pinned so a change is deliberate)", () => {
    for (const t of tools.filter(
      (t) => t.classification !== "READ" && funcName(t).startsWith("upsert")
    )) {
      expect(t.permission.actions, t.name).toEqual(["create", "update"]);
    }
  });

  it("insert|create|add|new|copy|duplicate|generate* ops gate on create", () => {
    for (const t of tools.filter(
      (t) =>
        t.classification !== "READ" &&
        !funcName(t).startsWith("upsert") &&
        /^(insert|create|add|new|copy|duplicate|generate)/.test(funcName(t))
    )) {
      expect(t.permission.actions, t.name).toEqual(["create"]);
    }
  });

  it("every remaining write verb gates on update", () => {
    for (const t of tools.filter(
      (t) =>
        t.classification !== "READ" &&
        !/^(upsert|delete|insert|create|add|new|copy|duplicate|generate)/.test(
          funcName(t)
        )
    )) {
      expect(t.permission.actions, t.name).toEqual(["update"]);
    }
  });

  it("every op has a non-empty actions array", () => {
    for (const t of tools) {
      expect(t.permission.actions.length, t.name).toBeGreaterThan(0);
    }
  });
});
