/**
 * Fixture-driven security gate. Every row in evaluations/attacks.jsonl names an
 * attack class, the boundary it probes and the runnable check that proves the
 * boundary holds. The runner accepts only commands of a known shape that point
 * at files present in the repository, requires every plan attack class to be
 * covered, and refuses to run when the fixture's row count changes without the
 * expected count below being updated deliberately.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_ATTACK_COUNT = 19;
const REQUIRED_CLASSES = [
  "identity-forgery",
  "release-profile",
  "browser-read-boundary",
  "manual-ingestion",
  "cache-revocation",
  "database-acl",
  "function-execution",
  "request-quota",
  "manual-workflow",
  "prompt-injection",
  "service-audience",
  "evidence-replay",
  "csrf",
  "ssrf",
  "query-exhaustion",
  "hidden-results",
  "cache-poisoning",
  "inaccessible-citation"
] as const;
const BOUNDARIES = [
  "identity",
  "acl-cache",
  "http",
  "ingestion",
  "postgres",
  "model"
] as const;

type Attack = {
  id: string;
  class: (typeof REQUIRED_CLASSES)[number];
  boundary: (typeof BOUNDARIES)[number];
  command: string;
  assertion: string;
  requiresDisposable?: boolean;
};

const packageDirectory = resolve(import.meta.dirname, "..");
const workspaceDirectories: Record<string, string> = {
  portal: resolve(packageDirectory, "../../apps/portal"),
  "portal-worker": resolve(packageDirectory, "../../apps/portal-worker"),
  "portal-query": resolve(packageDirectory, "../../apps/portal-query")
};
const commandShapes = [
  {
    pattern:
      /^corepack pnpm exec vitest run(?: --config vitest\.integration\.config\.ts)?((?: src\/[A-Za-z0-9_./-]+\.test\.ts)+)$/,
    directory: () => packageDirectory
  },
  {
    pattern:
      /^corepack pnpm --filter (portal|portal-worker|portal-query) exec vitest run((?: (?:src|app)\/[A-Za-z0-9_./-]+\.test\.tsx?)+)$/,
    directory: (match: RegExpMatchArray) => workspaceDirectories[match[1]!]!
  },
  {
    pattern: /^python3( scripts\/test_[a-z_]+\.py)$/,
    directory: () => packageDirectory
  }
];

/** A command is runnable only when it has a known shape and every file it names exists. */
function validateCommand(command: string): void {
  for (const shape of commandShapes) {
    const match = command.match(shape.pattern);
    if (!match) continue;
    const files = match[match.length - 1]!.trim().split(" ");
    const missing = files.filter(
      (file) => !existsSync(resolve(shape.directory(match), file))
    );
    if (missing.length)
      throw new Error(`Security attack command names missing files: ${missing.join(", ")}`);
    return;
  }
  throw new Error(`Security attack command has an unknown shape: ${command}`);
}

async function loadAttacks(): Promise<Attack[]> {
  const path = resolve(import.meta.dirname, "../evaluations/attacks.jsonl");
  const attacks = (await readFile(path, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Attack);
  if (attacks.length !== EXPECTED_ATTACK_COUNT)
    throw new Error(
      `Security attack fixture has ${attacks.length} rows; expected ${EXPECTED_ATTACK_COUNT}. Update EXPECTED_ATTACK_COUNT deliberately when adding or removing an attack.`
    );
  const ids = new Set<string>();
  for (const attack of attacks) {
    if (
      !/^S\d\d-[a-z-]+$/.test(attack.id) ||
      ids.has(attack.id) ||
      !REQUIRED_CLASSES.includes(attack.class) ||
      !BOUNDARIES.includes(attack.boundary) ||
      !attack.assertion ||
      typeof attack.command !== "string" ||
      (attack.requiresDisposable !== undefined &&
        typeof attack.requiresDisposable !== "boolean")
    )
      throw new Error(`Invalid security attack fixture: ${JSON.stringify(attack.id)}`);
    validateCommand(attack.command);
    ids.add(attack.id);
  }
  const covered = new Set(attacks.map((attack) => attack.class));
  const uncovered = REQUIRED_CLASSES.filter((name) => !covered.has(name));
  if (uncovered.length)
    throw new Error(`Security attack fixture lacks classes: ${uncovered.join(", ")}`);
  return attacks;
}

const disposableConfigured =
  process.env.PORTAL_TEST_DATABASE_DISPOSABLE === "1" &&
  !!process.env.PORTAL_TEST_DATABASE_URL;

for (const attack of await loadAttacks()) {
  if (attack.requiresDisposable && !disposableConfigured)
    throw new Error(
      `Security attack ${attack.id} requires the explicitly labelled disposable PostgreSQL fixture`
    );
  const [command, ...args] = attack.command.split(" ");
  process.stdout.write(`security ${attack.id} [${attack.class}] (${attack.boundary})\n`);
  const result = spawnSync(command!, args, {
    cwd: packageDirectory,
    stdio: "inherit",
    env: process.env
  });
  if (result.status !== 0)
    throw new Error(`Security attack gate failed: ${attack.id}`);
}
process.stdout.write(
  `security gate passed: ${EXPECTED_ATTACK_COUNT} attacks across ${REQUIRED_CLASSES.length} classes\n`
);
