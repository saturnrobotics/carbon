import { describe, expect, it } from "vitest";
import { keyOf, loadBaseline } from "../baseline";
import { loadSqlFiles, migrationsDir, repoRoot } from "../sources/migrations";
import { loadModules, modulesDir } from "../sources/modules";
import { moduleShape } from "./module-shape";
import { noLegacyRls } from "./no-legacy-rls";

const baseline = loadBaseline();
const root = repoRoot();
const receiptMigration = loadSqlFiles(migrationsDir(root)).find(
  ({ file }) => file === "20260908004744_knowledge-command-receipts.sql"
);
const knowledge = loadModules(modulesDir(root)).find(
  ({ name }) => name === "knowledge"
);

if (!receiptMigration || !knowledge) {
  throw new Error("Reviewed knowledge sources are missing");
}

// The knowledge API has no UI and keeps types beside its models/services.
// Grandfather these two omissions, not missing service/model/barrel contracts.
describe("reviewed knowledge conformance exceptions", () => {
  it("accepts only the existing module's two reviewed layout omissions", () => {
    const findings = moduleShape.inspect(knowledge);
    expect(findings.map(({ snippet }) => snippet).sort()).toEqual([
      "missing:types.ts",
      "missing:ui"
    ]);
    expect(
      findings.filter(
        (finding) => !baseline.has(keyOf(moduleShape.id, finding))
      )
    ).toEqual([]);
  });

  it("still rejects a lost barrel or service in the knowledge module", () => {
    const findings = moduleShape.inspect({
      ...knowledge,
      entries: knowledge.entries.filter(
        (entry) => entry !== "index.ts" && entry !== "knowledge.service.ts"
      )
    });
    const unreviewed = findings.filter(
      (finding) => !baseline.has(keyOf(moduleShape.id, finding))
    );
    expect(unreviewed.map(({ snippet }) => snippet).sort()).toEqual([
      "missing:index.ts",
      "missing:knowledge.service.ts"
    ]);
  });

  it("does not exempt another API module from the layout rule", () => {
    const findings = moduleShape.inspect({
      name: "example-api",
      dir: "/synthetic/example-api",
      entries: ["index.ts", "example-api.service.ts", "example-api.models.ts"]
    });
    expect(findings).toHaveLength(2);
    expect(
      findings.every((finding) => !baseline.has(keyOf(moduleShape.id, finding)))
    ).toBe(true);
  });

  // Applied migrations are immutable. Both historical calls share one baseline
  // key; a new migration must still use the current permission helper.
  it("grandfathers the two legacy calls in the immutable receipt migration", () => {
    const findings = noLegacyRls.scan(
      receiptMigration.file,
      receiptMigration.contents
    );
    expect(findings).toHaveLength(2);
    expect(
      findings.filter(
        (finding) => !baseline.has(keyOf(noLegacyRls.id, finding))
      )
    ).toEqual([]);
  });

  it("rejects the same legacy calls when copied into a new migration", () => {
    const findings = noLegacyRls.scan(
      "20990101000000_example-receipts.sql",
      receiptMigration.contents
    );
    expect(findings).toHaveLength(2);
    expect(
      findings.every((finding) => !baseline.has(keyOf(noLegacyRls.id, finding)))
    ).toBe(true);
  });
});
