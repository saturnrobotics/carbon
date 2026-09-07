#!/usr/bin/env python3
"""Run an explicit private synthetic evaluation in the deployed revision's Ops image."""
import argparse
import json
from pathlib import Path
import subprocess


PRIVATE_ROOT = Path("/var/lib/carbon/invoice-evaluation")
RUNTIME = Path("/var/lib/carbon/runtime/compose.json")


def run_evaluation(directory, apply=False, runtime=RUNTIME):
    directory = directory.resolve()
    if not directory.is_relative_to(PRIVATE_ROOT):
        raise ValueError("Use a private subdirectory of /var/lib/carbon/invoice-evaluation")
    if not (directory / "live.json").is_file() or not (directory / "fixtures.json").is_file():
        raise ValueError("Copy live.json and the generated synthetic corpus into the private VM directory")
    if (directory / "live.json").stat().st_mode & 0o077:
        raise ValueError("live.json must be mode 0600")
    stack = json.loads(runtime.read_text())
    ops, erp = stack["services"]["ops"], stack["services"]["erp"]
    ops["environment"] = {**erp["environment"], **ops["environment"], "INVOICE_EVAL_LIVE": "true", "INVOICE_EVAL_SCHEDULER_PAUSED": "true", "INVOICE_EVAL_DIRECTORY": "/evaluation"}
    ops["secrets"] = list(dict.fromkeys([*ops["secrets"], *erp["secrets"]]))
    ops["volumes"].append({"type": "bind", "source": str(directory), "target": "/evaluation"})
    ops["working_dir"] = "/repo/apps/erp"
    ops["command"] = ["pnpm", "exec", "vitest", "run", "--config", "app/modules/invoicing/invoice-evaluation.vitest.config.ts", "app/modules/invoicing/invoice-intake.live.test.ts"]
    output = directory / "evaluation-compose.json"
    output.write_text(json.dumps(stack)); output.chmod(0o600)
    print("Prepared the deployed Ops image evaluation; no provider requests have run.", flush=True)
    if not apply:
        return
    base = ["docker", "compose", "--project-name", "carbon", "--file", str(runtime)]
    status = subprocess.run([*base, "ps", "--status", "running", "--services", "inngest"], check=True, capture_output=True, text=True)
    was_running = "inngest" in status.stdout.splitlines()
    log = directory / "live.log"
    with log.open("w") as private_log:
        log.chmod(0o600)
        try:
            if was_running:
                subprocess.run([*base, "stop", "inngest"], check=True, stdout=private_log, stderr=subprocess.STDOUT)
            result = subprocess.run(["docker", "compose", "--project-name", "carbon", "--file", str(output), "--profile", "ops", "run", "--rm", "--no-deps", "ops"], stdout=private_log, stderr=subprocess.STDOUT)
        finally:
            if was_running:
                subprocess.run([*base, "start", "inngest"], check=True, stdout=private_log, stderr=subprocess.STDOUT)
    if result.returncode:
        raise ValueError("Live evaluation did not pass; inspect private live.log and report.json")
    print("Live evaluation passed. Private samples and report saved.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True, help="Private VM directory containing corpus and mode-0600 live.json")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    run_evaluation(args.directory, args.apply)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError):
        raise SystemExit("Invoice evaluation failed; inspect the private configuration, runtime state, and evaluation logs")
