import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalBackup, canonicalTypes } from "../schema-artifacts";

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
