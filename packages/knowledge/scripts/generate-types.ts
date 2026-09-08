import { writeFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { getDisposableLocalDatabaseUrl } from "../src/test/database";

// Direct catalogue introspection avoids a second container's loopback namespace.
// Input remains restricted to an explicitly disposable, local migrated DB.
const pool = new pg.Pool({ connectionString: getDisposableLocalDatabaseUrl(), max: 1 });
type Column = { table_name: string; column_name: string; udt_name: string; is_nullable: string; column_default: string | null; is_generated: string };
function typeFor(type: string): string {
  if (["json", "jsonb"].includes(type)) return "Json";
  if (["int2", "int4", "float4", "float8"].includes(type)) return "number";
  if (type === "bool") return "boolean";
  if (type.startsWith("_")) return `Array<${typeFor(type.slice(1))}>`;
  // pg returns NUMERIC and bigint as strings; preserve precision.
  return "string";
}
try {
  const ledger = await pool.query("SELECT count(*)::int AS count FROM knowledge_migrations.ledger");
  if (!ledger.rows[0]?.count) throw new Error("Apply knowledge migrations before generation");
  const { rows } = await pool.query<Column>(`SELECT table_name,column_name,udt_name,is_nullable,column_default,is_generated
    FROM information_schema.columns WHERE table_schema='knowledge' ORDER BY table_name,ordinal_position`);
  if (rows.length === 0) throw new Error("Knowledge schema is missing");
  const output = ["// Generated from migration-built local PostgreSQL by scripts/generate-types.ts. Do not edit.",
    "export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];",
    "export type Database = { knowledge: { Tables: {"];
  for (const table of [...new Set(rows.map((row) => row.table_name))]) {
    const columns = rows.filter((row) => row.table_name === table);
    output.push(`${JSON.stringify(table)}: {`);
    for (const shape of ["Row", "Insert", "Update"]) {
      output.push(`${shape}: {`);
      for (const column of columns) {
        if (shape !== "Row" && column.is_generated === "ALWAYS") continue;
        const optional = shape === "Update" || (shape === "Insert" && (column.is_nullable === "YES" || column.column_default !== null));
        output.push(`${JSON.stringify(column.column_name)}${optional ? "?" : ""}: ${typeFor(column.udt_name)}${column.is_nullable === "YES" ? " | null" : ""};`);
      }
      output.push("};");
    }
    output.push("};");
  }
  output.push("} } };", "");
  const target = resolve(import.meta.dirname, "../src/database.types.ts");
  const temporary = `${target}.tmp`;
  try {
    await writeFile(temporary, output.join("\n"));
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Generated ${new Set(rows.map((row) => row.table_name)).size} knowledge tables`);
} finally {
  await pool.end();
}
