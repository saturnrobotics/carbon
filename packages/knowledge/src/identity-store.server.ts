import type { Pool } from "pg";
import type {
  IdentityBinding,
  WorkforceIdentityStore
} from "./identity.server";

/** The source-owned function returns one verified subject's current membership. */
export function postgresIdentityStore(pool: Pool): WorkforceIdentityStore {
  return {
    async resolveHuman({ issuer, subject, companyId }) {
      if (
        !issuer ||
        !subject ||
        !companyId ||
        [issuer, subject, companyId].some((value) => value.length > 2048)
      )
        return null;
      const result = await pool.query<{ binding: IdentityBinding | null }>(
        "SELECT public.knowledge_resolve_workforce_identity($1::text,$2::text,$3::text) AS binding",
        [issuer, subject, companyId]
      );
      return result.rows[0]?.binding ?? null;
    }
  };
}
