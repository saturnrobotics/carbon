import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

test("Inngest wires each dispatcher once and preserves the current operation context", async () => {
  const workflow: Function[] = [];
  const procurement: Function[] = [];
  const validation: Function[] = [];
  const calls: unknown[][] = [];
  const validate = () => undefined;
  const code = ts.transpileModule(
    readFileSync(resolve("apps/erp/app/routes/api+/inngest.ts"), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }
  ).outputText;
  const exports: Record<string, Function> = {};
  runInNewContext(code, {
    exports,
    process: { env: {} },
    require: (name: string) => {
      if (name === "@carbon/jobs/inngest") {
        return {
          functions: [],
          inngest: {},
          setWorkflowDispatch: (fn: Function) => workflow.push(fn),
          setProcurementScheduleDispatch: (fn: Function) =>
            procurement.push(fn),
          setInvoiceIntakeValidation: (fn: Function) => validation.push(fn)
        };
      }
      if (name === "@carbon/auth/client.server")
        return { getUserScopedClient: async () => "scoped-client" };
      if (name === "inngest/remix") return { serve: () => () => "handled" };
      if (name.endsWith("call.server"))
        return {
          callOperation: (...args: unknown[]) => {
            calls.push(args);
            return "result";
          }
        };
      if (name === "~/modules/invoicing/invoicing.server")
        return { validateHydratedInvoiceIntake: validate };
      // Model the obsolete dispatcher as a separate dependency so the regression
      // fails on its observable overwrite, not on a missing-module import error.
      if (name.endsWith("direct-executor"))
        return { executeFunction: () => "obsolete" };
      throw new Error(`Unexpected dependency: ${name}`);
    }
  });
  assert.equal(workflow.length, 0);
  assert.equal(exports.loader?.({}), "handled");
  assert.equal(exports.action?.({}), "handled");
  assert.equal(
    workflow.length,
    1,
    "one dispatch registration across loader and action"
  );
  assert.equal(procurement.length, 1);
  assert.equal(validation.length, 1);
  assert.equal(validation[0], validate);
  const context = {
    userId: "fixture-user",
    companyId: "fixture-company",
    client: "original-client"
  };
  assert.equal(
    await workflow[0]?.("fixture_operation", context, { value: 1 }),
    "result"
  );
  assert.equal(
    JSON.stringify(calls[0]),
    JSON.stringify([
      "fixture_operation",
      { ...context, authKind: "session", scopes: {} },
      { value: 1 }
    ])
  );
  await procurement[0]?.(context, { fixture: true });
  assert.equal(
    JSON.stringify(calls[1]),
    JSON.stringify([
      "knowledge_createProcurementDraft",
      { ...context, client: "scoped-client", authKind: "session", scopes: {} },
      { fixture: true }
    ])
  );
});
