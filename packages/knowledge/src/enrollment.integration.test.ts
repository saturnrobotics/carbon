import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enrollWorkforceIdentity,
  IAP_ISSUER,
  unbindWorkforceIdentity
} from "./enrollment.server";
import { getDisposableLocalDatabaseUrl } from "./test/database";

// Reserved synthetic IAP subject; every case rolls back.
const subject = "accounts.google.com:100000000000000000951";

describe("workforce identity enrollment wrappers on disposable PostgreSQL", () => {
  const pool = new pg.Pool({
    connectionString: getDisposableLocalDatabaseUrl(),
    max: 1,
    connectionTimeoutMillis: 5_000
  });
  let client: pg.PoolClient;

  beforeAll(async () => {
    client = await pool.connect();
  });

  afterAll(async () => {
    client?.release();
    await pool.end();
  });

  async function inTransaction<T>(operation: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      return await operation();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  it("enrolls, re-enrolls idempotently and unbinds through the migrate login", async () => {
    await inTransaction(async () => {
      const enrolled = await enrollWorkforceIdentity(client, {
        subject,
        companyId: "company-a",
        userId: "alice",
        capabilities: ["knowledge.read", "source.entities.search"]
      });
      expect(enrolled.issuer).toBe(IAP_ISSUER);
      expect(enrolled.canonicalUserId).toBe("alice");
      expect(enrolled.active).toBe(true);
      expect(enrolled.revocationVersion).toBe(1);
      expect(enrolled.version).toBe(1);
      expect(enrolled.capabilities).toEqual([
        "knowledge.read",
        "source.entities.search"
      ]);

      const again = await enrollWorkforceIdentity(client, {
        subject,
        companyId: "company-a",
        userId: "alice",
        capabilities: ["source.entities.search", "knowledge.read"]
      });
      expect(again).toEqual(enrolled);

      const unbound = await unbindWorkforceIdentity(client, {
        subject,
        companyId: "company-a"
      });
      expect(unbound.id).toBe(enrolled.id);
      expect(unbound.active).toBe(false);
      expect(unbound.revocationVersion).toBe(2);

      const resolved = await client.query<{
        binding: { bindingActive: boolean };
      }>(
        "SELECT public.knowledge_resolve_workforce_identity($1,$2,$3) AS binding",
        [IAP_ISSUER, subject, "company-a"]
      );
      expect(resolved.rows[0]?.binding.bindingActive).toBe(false);
    });
  });

  it("is refused by the database for an email-shaped subject even when the client check is bypassed", async () => {
    await inTransaction(async () => {
      await expect(
        client.query(
          "SELECT knowledge.enroll_workforce_identity($1,$2,$3,$4,$5::text[])",
          [
            IAP_ISSUER,
            "alice@example.com",
            "company-a",
            "alice",
            ["knowledge.read"]
          ]
        )
      ).rejects.toMatchObject({ code: "22023" });
    });
  });

  it("is refused for a user without current membership in the company", async () => {
    await inTransaction(async () => {
      await expect(
        enrollWorkforceIdentity(client, {
          subject,
          companyId: "company-a",
          userId: "bob",
          capabilities: ["knowledge.read"]
        })
      ).rejects.toMatchObject({ code: "P0002" });
    });
  });

  it("cannot be executed by the read-only runtime role", async () => {
    await inTransaction(async () => {
      await client.query("SET LOCAL ROLE knowledge_read");
      await expect(
        enrollWorkforceIdentity(client, {
          subject,
          companyId: "company-a",
          userId: "alice",
          capabilities: ["knowledge.read"]
        })
      ).rejects.toMatchObject({ code: "42501" });
    });
  });
});
