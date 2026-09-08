import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalBackup,
  canonicalSwagger,
  canonicalTypes
} from "../schema-artifacts";

test("database relationship ordering and source formatting do not create drift", () => {
  const a =
    'export type Database = { public: { Relationships: [{ foreignKeyName: "a" }, { foreignKeyName: "b" }] } };';
  const b =
    'export type Database={public:{Relationships:[{foreignKeyName:"b"},{foreignKeyName:"a"}]}}';
  assert.equal(canonicalTypes(a), canonicalTypes(b));
});

test("a relationship definition change remains visible", () => {
  assert.notEqual(
    canonicalTypes(
      'export type Database = { Relationships: [{ columns: ["a"] }] };'
    ),
    canonicalTypes(
      'export type Database = { Relationships: [{ columns: ["b"] }] };'
    )
  );
});

test("invalid generated TypeScript is rejected", () => {
  assert.throws(() => canonicalTypes("export type Database = {"), /TypeScript/);
});

test("backup timestamps and object-key formatting are incidental", () => {
  assert.equal(
    canonicalBackup('{"tables":[],"schemaVersion":"1","exportedAt":"first"}'),
    canonicalBackup('{"exportedAt":"second","schemaVersion":"1","tables":[]}')
  );
});

test("backup table/column changes remain visible", () => {
  assert.notEqual(
    canonicalBackup('{"tables":[{"name":"a","columns":["id"]}]}'),
    canonicalBackup('{"tables":[{"name":"a","columns":["id","value"]}]}')
  );
});

test("Swagger quote escapes, array layout and object key order represent the same data", () => {
  const a = String.raw`export default { format: 'public."accountType"', enum: ["one", "two"], description: "line\n\u0061", nested: { b: true, a: null } };`;
  const b = String.raw`export default {
    nested: { a: null, b: true },
    description: 'line\na',
    enum: [
      'one',
      'two',
    ],
    "format": "public.\"accountType\"",
  }`;
  assert.equal(canonicalSwagger(a), canonicalSwagger(b));
  assert.deepEqual(JSON.parse(canonicalSwagger(a)), {
    format: 'public."accountType"',
    enum: ["one", "two"],
    description: "line\na",
    nested: { a: null, b: true }
  });
});

for (const [a, b] of [
  ["This is a Primary Key.<pk/>", ""],
  ["<fk table='first' column='id'/>", "<fk table='second' column='id'/>"],
  ["Original user documentation", "Changed user documentation"],
  ["line\nnext", "line\\nnext"]
]) {
  test(`Swagger string content remains significant: ${JSON.stringify(a)}`, () => {
    assert.notEqual(
      canonicalSwagger(`export default ${JSON.stringify({ description: a })}`),
      canonicalSwagger(`export default ${JSON.stringify({ description: b })}`)
    );
  });
}

test("Swagger array order remains significant at every nesting level", () => {
  assert.notEqual(
    canonicalSwagger('export default { required: ["id", "companyId"] }'),
    canonicalSwagger('export default { required: ["companyId", "id"] }')
  );
  assert.notEqual(
    canonicalSwagger("export default { nested: [{ value: [1, 2] }] }"),
    canonicalSwagger("export default { nested: [{ value: [2, 1] }] }")
  );
});

test("Swagger accepts finite literal numbers, booleans and null", () => {
  assert.equal(
    canonicalSwagger("export default { a: -1.25, b: 2e3, c: false, d: null }"),
    '{"a":-1.25,"b":2000,"c":false,"d":null}'
  );
});

test("Swagger object keys use a total order without merging Unicode spellings", () => {
  const a = 'export default { "é": 1, "é": 2 }';
  const b = 'export default { "é": 2, "é": 1 }';
  assert.equal(canonicalSwagger(a), canonicalSwagger(b));
  assert.equal(Object.keys(JSON.parse(canonicalSwagger(a))).length, 2);
});

for (const source of [
  "export default {",
  "",
  "export default [];",
  "export = {};",
  "export default {}; export default {};",
  "declare export default {};",
  "abstract export default {};",
  "const hidden = 1; export default {};",
  "export default {}; hidden();",
  "import './side-effects'; export default {};",
  "export default { value: hidden() };",
  "export default { get value() { return 1; } };",
  "export default { value() { return 1; } };",
  "export default { ...hidden };",
  "export default { value };",
  "export default { ['value']: 1 };",
  "export default { value: [1,,2] };",
  "export default { value: [...hidden] };",
  "export default { value: 1 + 2 };",
  "export default { value: undefined };",
  "export default { value?: 1 };",
  "export default { value!: 1 };",
  "export default { readonly value: 1 };",
  "export default { value: NaN };",
  "export default { value: Infinity };",
  "export default { value: 1e999 };",
  "export default { value: -1e999 };",
  "export default { value: 1n };",
  `export default { value: \`template \${hidden}\` };`,
  "export default { value: 1, value: 2 };",
  'export default { value: 1, "value": 2 };',
  String.raw`export default { value: 1, "\u0076alue": 2 };`,
  'export default { 1: "one", "1": "two" };',
  'export default { 1e3: "one", "1000": "two" };',
  "export default { nested: { duplicate: 1, duplicate: 2 } };"
]) {
  test(`Swagger rejects executable, ambiguous or invalid content: ${source}`, () => {
    assert.throws(() => canonicalSwagger(source), /Swagger|TypeScript/);
  });
}

test("Swagger literal prototype-named fields cannot disappear from comparison", () => {
  assert.notEqual(
    canonicalSwagger('export default { "__proto__": { value: 1 } }'),
    canonicalSwagger("export default {}")
  );
  assert.equal(
    canonicalSwagger('export default { "__proto__": { value: 1 } }'),
    '{"__proto__":{"value":1}}'
  );
});

test("the real Swagger CLI hashes decoded data rather than TypeScript printer output", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const directory = mkdtempSync(join(tmpdir(), "carbon-swagger-comparison-"));
  try {
    const fixture = join(directory, "schema.ts");
    writeFileSync(
      fixture,
      String.raw`export default { format: 'public."accountType"', values: [1, 2] };`
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        join(root, "node_modules/tsx/dist/loader.mjs"),
        join(root, ".fork/schema-artifacts.ts"),
        "canonical",
        "swagger",
        fixture
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { PATH: process.env.PATH, NODE_PATH: undefined }
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const expected = createHash("sha256")
      .update(
        JSON.stringify({ format: 'public."accountType"', values: [1, 2] })
      )
      .digest("hex");
    assert.equal(result.stdout.trim(), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
