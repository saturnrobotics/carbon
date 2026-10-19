// Test helper: a Kysely database that answers carbon_private's status function
// from a mutable value and records what was asked.
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult
} from "kysely";

export type StatusRow = { enabled: boolean; access_url: string | null };

export function fakeStatusDatabase() {
  const state = {
    status: { enabled: false, access_url: null } as StatusRow | Error,
    queries: [] as string[]
  };
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      state.queries.push(query.sql);
      if (state.status instanceof Error) throw state.status;
      return { rows: [state.status] as R[] };
    },
    streamQuery() {
      throw new Error("not used");
    }
  };
  // Connection and transaction lifecycle are no-ops for a canned answer.
  const nothing = async () => undefined;
  const driver: Driver = {
    init: nothing,
    acquireConnection: async () => connection,
    beginTransaction: nothing,
    commitTransaction: nothing,
    rollbackTransaction: nothing,
    releaseConnection: nothing,
    destroy: nothing
  };
  const db = new Kysely<never>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  return { db, state };
}

export const MANAGED: StatusRow = {
  enabled: true,
  access_url: "https://hq.example.com/admin/access"
};
