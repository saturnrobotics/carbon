/**
 * Deployment verification: compare an expected release manifest (the private
 * file `release.py` writes) with an observed target, and prove no-op/isolated
 * rollouts by comparing two observations. No cloud call is ever made here; an
 * operator produces the observation privately, or `--local` reads the local
 * Docker stack from `contrib/deploying/portal/compose.local.yaml`.
 *
 *   verify-deployment.ts --self-test
 *   verify-deployment.ts --expected <manifest.json> --observed <observed.json>
 *       [--previous <observed.json>] [--deploy web,query] [--dry-run]
 *   verify-deployment.ts --local [--snapshot <out.json>] [--previous <snapshot.json>]
 *       [--deploy portal] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type ObservedService = {
  revision_digest?: string;
  image_digest?: string;
  deployed_revision?: string;
  container_id?: string;
  image_id?: string;
  started_at?: string;
};
export type ObservedTarget = {
  schemaVersion: 1;
  observedAt: string;
  target: string;
  services: Record<string, ObservedService>;
  migrations?: { head: string | null; count: number };
  database?: { startedAt?: string };
};
export type ReleaseManifest = {
  generation: number;
  services: Record<
    string,
    {
      revision_digest: string;
      image_digest?: string;
      deployed_revision?: string | null;
    }
  >;
};

const comparedFields = [
  "revision_digest",
  "image_digest",
  "deployed_revision"
] as const;
const identityFields = [
  "container_id",
  "image_id",
  "started_at",
  "deployed_revision",
  "revision_digest",
  "image_digest"
] as const;

export function compareDeployment(
  expected: ReleaseManifest,
  observed: ObservedTarget
) {
  const services = Object.keys(expected.services)
    .sort()
    .map((name) => {
      const want = expected.services[name]!;
      const have = observed.services[name];
      if (!have) return { name, status: "missing" as const, fields: [] };
      const fields = comparedFields.filter(
        (field) =>
          want[field] !== undefined &&
          want[field] !== null &&
          have[field] !== undefined &&
          want[field] !== have[field]
      );
      return {
        name,
        status: fields.length ? ("drift" as const) : ("match" as const),
        fields: [...fields]
      };
    });
  const unexpected = Object.keys(observed.services)
    .filter((name) => !(name in expected.services))
    .sort();
  return {
    ok: services.every((row) => row.status === "match"),
    generation: expected.generation,
    services,
    unexpected
  };
}

export function compareIsolation(
  before: ObservedTarget,
  after: ObservedTarget,
  deployed: readonly string[]
) {
  const names = [
    ...new Set([...Object.keys(before.services), ...Object.keys(after.services)])
  ].sort();
  const services = names.map((name) => {
    const previous = before.services[name];
    const current = after.services[name];
    if (!previous || !current)
      return { name, status: "missing" as const, fields: [] };
    const fields = identityFields.filter(
      (field) =>
        previous[field] !== undefined &&
        current[field] !== undefined &&
        previous[field] !== current[field]
    );
    const selected = deployed.includes(name);
    const status = selected
      ? fields.length
        ? ("changed" as const)
        : ("unchanged-despite-selection" as const)
      : fields.length
        ? ("disturbed" as const)
        : ("untouched" as const);
    return { name, status, fields: [...fields] };
  });
  const schemaSelected = deployed.some((name) => /schema/.test(name));
  const migrationsUnchanged =
    schemaSelected ||
    before.migrations === undefined ||
    after.migrations === undefined ||
    (before.migrations.head === after.migrations.head &&
      before.migrations.count === after.migrations.count);
  const databaseUptimePreserved =
    before.database?.startedAt === undefined ||
    after.database?.startedAt === undefined ||
    before.database.startedAt === after.database.startedAt;
  return {
    ok:
      services.every(
        (row) => row.status === "untouched" || row.status === "changed"
      ) &&
      migrationsUnchanged &&
      databaseUptimePreserved,
    deployed: [...deployed],
    services,
    migrationsUnchanged,
    databaseUptimePreserved
  };
}

const composeFile = resolve(
  import.meta.dirname,
  "../../../contrib/deploying/portal/compose.local.yaml"
);
const localServices = [
  "postgres",
  "storage",
  "redis",
  "ingest",
  "inngest",
  "query",
  "parser",
  "storage-api",
  "portal"
] as const;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** Observe the local Docker stack; container identity stands in for a Cloud Run revision. */
export function observeLocalStack(): ObservedTarget | null {
  let running: string[];
  try {
    running = docker([
      "compose",
      "-f",
      composeFile,
      "ps",
      "--services",
      "--status",
      "running"
    ])
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
  if (!running.length) return null;
  const services: Record<string, ObservedService> = {};
  for (const service of localServices) {
    if (!running.includes(service)) continue;
    const containerId = docker([
      "compose",
      "-f",
      composeFile,
      "ps",
      "-q",
      service
    ]);
    if (!containerId) continue;
    const inspected = JSON.parse(
      docker(["inspect", containerId])
    )[0] as {
      Id: string;
      Image: string;
      State: { StartedAt: string };
      Config: { Image: string };
    };
    const repoDigests = JSON.parse(
      docker(["image", "inspect", inspected.Image, "--format", "{{json .RepoDigests}}"])
    ) as string[] | null;
    services[service] = {
      container_id: inspected.Id,
      image_id: inspected.Image,
      started_at: inspected.State.StartedAt,
      deployed_revision: inspected.Config.Image,
      ...(repoDigests?.[0]
        ? { image_digest: repoDigests[0].split("@")[1] }
        : {})
    };
  }
  const observation: ObservedTarget = {
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    target: "local-docker",
    services
  };
  const postgres = running.includes("postgres")
    ? docker(["compose", "-f", composeFile, "ps", "-q", "postgres"])
    : "";
  if (postgres) {
    const psql = (statement: string) =>
      docker([
        "exec",
        "-e",
        "PGPASSWORD=synthetic-test-only",
        postgres,
        "psql",
        "-X",
        "-U",
        "supabase_admin",
        "-d",
        "portal_test",
        "-At",
        "-c",
        statement
      ]);
    const [head, count] = psql(
      "SELECT coalesce(max(name),''), count(*) FROM portal_migrations.ledger"
    ).split("|");
    observation.migrations = { head: head || null, count: Number(count ?? 0) };
    observation.database = {
      startedAt: psql("SELECT to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')")
    };
  }
  return observation;
}

function synthetic(
  overrides: Record<string, Partial<ObservedService>> = {},
  extra: Partial<ObservedTarget> = {}
): ObservedTarget {
  const base: Record<string, ObservedService> = {
    "portal-web": {
      revision_digest: "sha256:web-1",
      image_digest: "sha256:img-web-1",
      deployed_revision: "portal-web-00001",
      container_id: "c-web-1",
      started_at: "2026-09-10T00:00:00Z"
    },
    "portal-query": {
      revision_digest: "sha256:query-1",
      image_digest: "sha256:img-query-1",
      deployed_revision: "portal-query-00001",
      container_id: "c-query-1",
      started_at: "2026-09-10T00:00:00Z"
    },
    "portal-schema": {
      revision_digest: "sha256:schema-1",
      image_digest: "sha256:img-schema-1",
      deployed_revision: "3"
    }
  };
  for (const [name, patch] of Object.entries(overrides))
    base[name] = { ...base[name], ...patch };
  return {
    schemaVersion: 1,
    observedAt: "2026-09-11T00:00:00Z",
    target: "synthetic",
    services: base,
    migrations: { head: "20260908050421_ingest-source-visibility-execute.sql", count: 33 },
    database: { startedAt: "2026-09-10T00:00:00Z" },
    ...extra
  };
}

/** Offline proof that the comparator reports no-ops, drift and disturbed neighbours. */
export function selfTest() {
  const manifest: ReleaseManifest = {
    generation: 4,
    services: {
      "portal-web": { revision_digest: "sha256:web-1", image_digest: "sha256:img-web-1", deployed_revision: "portal-web-00001" },
      "portal-query": { revision_digest: "sha256:query-1", image_digest: "sha256:img-query-1", deployed_revision: "portal-query-00001" },
      "portal-schema": { revision_digest: "sha256:schema-1", image_digest: "sha256:img-schema-1", deployed_revision: "3" }
    }
  };
  const baseline = synthetic();
  const cases = {
    sameInputIsNoop: compareDeployment(manifest, baseline).ok,
    driftIsReported: (() => {
      const result = compareDeployment(manifest, synthetic({ "portal-query": { revision_digest: "sha256:hand-edited" } }));
      return !result.ok && result.services.find((row) => row.name === "portal-query")?.status === "drift";
    })(),
    missingIsReported: compareDeployment(manifest, synthetic({}, { services: { "portal-web": baseline.services["portal-web"]! } })).services.some((row) => row.status === "missing"),
    webOnlyIsIsolated: (() => {
      const result = compareIsolation(baseline, synthetic({ "portal-web": { revision_digest: "sha256:web-2", image_digest: "sha256:img-web-2", deployed_revision: "portal-web-00002", container_id: "c-web-2", started_at: "2026-09-11T00:00:00Z" } }), ["portal-web"]);
      return result.ok && result.services.map((row) => `${row.name}:${row.status}`).join(",") === "portal-query:untouched,portal-schema:untouched,portal-web:changed";
    })(),
    disturbedNeighbourFails: !compareIsolation(baseline, synthetic({ "portal-query": { container_id: "c-query-2", started_at: "2026-09-11T00:00:00Z" } }), ["portal-web"]).ok,
    schemaChangeWithoutSchemaDeployFails: !compareIsolation(baseline, synthetic({}, { migrations: { head: "20260912000000_new.sql", count: 34 } }), ["portal-web"]).ok,
    schemaDeployMayAdvanceLedger: compareIsolation(baseline, synthetic({ "portal-schema": { deployed_revision: "4" } }, { migrations: { head: "20260912000000_new.sql", count: 34 } }), ["portal-schema"]).ok,
    databaseRestartFails: !compareIsolation(baseline, synthetic({}, { database: { startedAt: "2026-09-11T00:00:00Z" } }), ["portal-web"]).ok
  };
  return { ok: Object.values(cases).every(Boolean), cases };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as T;
}

export function main(): number {
  const flags = new Set(process.argv.slice(2).filter((value) => value.startsWith("--")));
  const dryRun = flags.has("--dry-run");
  const deploy = (argument("--deploy") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const previousPath = argument("--previous");
  const report: Record<string, unknown> = { schemaVersion: 1 };
  let ok = true;
  if (flags.has("--local")) {
    const observed = observeLocalStack();
    report.mode = "local-docker";
    if (!observed) {
      report.stack = "unavailable";
      report.note = "no running compose service; start it with contrib/deploying/portal/local-stack.sh up";
      console.log(JSON.stringify(report, null, 2));
      return dryRun ? 0 : 1;
    }
    report.stack = "running";
    report.observed = observed;
    const snapshot = argument("--snapshot");
    if (snapshot) writeFileSync(resolve(process.cwd(), snapshot), `${JSON.stringify(observed, null, 2)}\n`);
    if (previousPath) {
      const isolation = compareIsolation(readJson<ObservedTarget>(previousPath), observed, deploy);
      report.isolation = isolation;
      ok = isolation.ok;
    } else {
      // Observation only: the stack compared with itself is the trivial no-op.
      report.isolation = compareIsolation(observed, observed, []);
      report.note = "observation only; pass --previous <snapshot> and --deploy <services> to prove an isolated update";
    }
  } else if (argument("--expected") || argument("--observed")) {
    const expectedPath = argument("--expected");
    const observedPath = argument("--observed");
    if (!expectedPath || !observedPath) throw new Error("--expected and --observed are both required");
    const observed = readJson<ObservedTarget>(observedPath);
    const comparison = compareDeployment(readJson<ReleaseManifest>(expectedPath), observed);
    report.mode = "manifest";
    report.comparison = comparison;
    ok = comparison.ok;
    if (previousPath) {
      const isolation = compareIsolation(readJson<ObservedTarget>(previousPath), observed, deploy);
      report.isolation = isolation;
      ok = ok && isolation.ok;
    }
  } else {
    const result = selfTest();
    report.mode = "self-test";
    report.selfTest = result;
    report.usage = "pass --expected/--observed for a target, or --local for the Docker stack";
    ok = result.ok;
  }
  report.ok = ok;
  report.dryRun = dryRun;
  console.log(JSON.stringify(report, null, 2));
  return ok || dryRun ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "deployment verification failed");
    process.exitCode = 1;
  }
}
