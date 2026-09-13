import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { applyPortalMigrations } from "./migrations.server";

describe("Portal migration transition", () => {
  it("refuses simultaneous legacy and Portal ledgers before applying SQL", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("AS legacy") ? [{ legacy: true, portal: true }] : []
    }));
    await expect(
      applyPortalMigrations({ query } as unknown as PoolClient, "unused")
    ).rejects.toThrow("Both legacy and Portal migration ledgers exist");
    expect(
      query.mock.calls.some(([sql]) => sql.includes("CREATE SCHEMA"))
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toContain("pg_advisory_unlock");
  });

  it("checks original historical bytes in the renamed ledger", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "portal-migration-checksum-")
    );
    const body = "-- historical knowledge SQL must remain immutable\n";
    const checksum = createHash("sha256").update(body).digest("hex");
    await writeFile(
      join(directory, "20260908000245_knowledge-foundation.sql"),
      body
    );
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("AS legacy"))
        return { rows: [{ legacy: false, portal: true }] };
      if (sql.includes("AS ready")) return { rows: [{ ready: true }] };
      if (sql.startsWith("SELECT checksum")) return { rows: [{ checksum }] };
      if (sql.includes("pg_catalog.pg_extension"))
        return { rows: [{ version: "0.8.0" }] };
      if (sql.includes('SELECT version FROM portal."extensionVersion"'))
        return { rows: [{ version: "0.8.0" }] };
      return { rows: [] };
    });
    try {
      const client = { query } as unknown as PoolClient;
      expect((await applyPortalMigrations(client, directory)).applied).toEqual(
        []
      );
      expect(query.mock.calls.some(([sql]) => sql === body)).toBe(false);
      await writeFile(
        join(directory, "20260908000245_knowledge-foundation.sql"),
        body.replace("knowledge", "portal")
      );
      await expect(applyPortalMigrations(client, directory)).rejects.toThrow(
        "Applied migration changed"
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
