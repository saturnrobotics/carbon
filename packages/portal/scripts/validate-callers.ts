/**
 * Validate a trusted-caller registry file before release.
 *
 *   pnpm --filter @carbon/portal callers:validate <registry.json> [--schema <schema.json>]
 *
 * Prints each caller's subject, operations and audiences, exits 1 on any issue
 * and 2 on a usage error. Paths resolve from the directory pnpm was invoked in.
 * Everything but the process wiring below lives in src/trusted-callers.ts.
 */
import { runCallerValidation } from "../src/trusted-callers";

process.exitCode = await runCallerValidation(
  process.argv.slice(2),
  {
    print: (line) => {
      process.stdout.write(`${line}\n`);
    },
    fail: (line) => {
      process.stderr.write(`${line}\n`);
    }
  },
  // pnpm runs package scripts from the package directory and records the
  // caller's directory in INIT_CWD, so repo-relative arguments resolve there.
  process.env.INIT_CWD ?? process.cwd()
);
