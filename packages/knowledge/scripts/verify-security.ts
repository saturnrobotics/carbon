import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

type Attack = {
  id: string;
  boundary: "identity" | "acl-cache" | "http" | "ingestion" | "postgres";
  command: string;
  assertion: string;
  requiresDisposable?: boolean;
};

const allowedCommands = new Set([
  "corepack pnpm exec vitest run src/identity.test.ts",
  "corepack pnpm exec vitest run src/release-profile.test.ts",
  "corepack pnpm --filter knowledge exec vitest run app/routes/api.query.test.ts app/routes/health.test.ts app/modules/manual-workflow.test.tsx",
  "corepack pnpm --filter knowledge-worker exec vitest run src/manual-file.test.ts src/manual-processor.test.ts src/runtime.test.ts src/server.test.ts",
  "corepack pnpm exec vitest run src/cache/cache.test.ts",
  "python3 scripts/test_schema.py",
  "python3 scripts/test_function_boundary.py",
  "python3 scripts/test_request_limits.py",
  "corepack pnpm exec vitest run --config vitest.integration.config.ts src/intake/manual-workflow.integration.test.ts"
]);

async function loadAttacks() {
  const path = resolve(import.meta.dirname, "../evaluations/attacks.jsonl");
  const lines = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim());
  const attacks = lines.map((line) => JSON.parse(line) as Attack);
  if (attacks.length !== allowedCommands.size)
    throw new Error("Security attack fixture is incomplete");
  const ids = new Set<string>();
  for (const attack of attacks) {
    if (
      !/^A\d\d-[a-z-]+$/.test(attack.id) ||
      ids.has(attack.id) ||
      !attack.assertion ||
      !allowedCommands.has(attack.command) ||
      (attack.requiresDisposable !== undefined &&
        typeof attack.requiresDisposable !== "boolean")
    ) {
      throw new Error(`Invalid security attack fixture: ${attack.id}`);
    }
    ids.add(attack.id);
  }
  return attacks;
}

for (const attack of await loadAttacks()) {
  if (
    attack.requiresDisposable &&
    (process.env.KNOWLEDGE_TEST_DATABASE_DISPOSABLE !== "1" ||
      !process.env.KNOWLEDGE_TEST_DATABASE_URL)
  ) {
    throw new Error(
      `Security attack ${attack.id} requires the explicitly labelled disposable PostgreSQL fixture`
    );
  }
  const [command, ...args] = attack.command.split(" ");
  process.stdout.write(`security ${attack.id} (${attack.boundary})\n`);
  const result = spawnSync(command!, args, {
    cwd: resolve(import.meta.dirname, ".."),
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0) {
    throw new Error(`Security attack gate failed: ${attack.id}`);
  }
}
process.stdout.write("security gate passed\n");
