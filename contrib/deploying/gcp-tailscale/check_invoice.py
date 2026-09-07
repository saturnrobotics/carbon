#!/usr/bin/env python3
"""Run invoice checks; database tests require explicit isolated local access."""

import argparse
import os
from pathlib import Path
import subprocess
import shlex
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[3]
DATABASE_KEYS = (
    "INVOICE_INTAKE_TEST_DATABASE_URL",
    "MERCURY_TEST_DATABASE_URL",
    "PAYMENT_SYNC_TEST_DATABASE_URL",
)
ERP_DATABASE_TESTS = (
    "app/modules/invoicing/invoice-intake.integration.test.ts",
    "app/modules/invoicing/mercury.integration.test.ts",
    "app/modules/invoicing/invoice-evaluation-training.test.ts",
    "app/modules/items/items.creation.integration.test.ts",
)
JOBS_DATABASE_TESTS = (
    "src/invoice-intake/ingestion.test.ts",
    "src/invoice-intake/backfill.test.ts",
    "src/invoice-intake/worker.test.ts",
    "src/payment-sync/sync.integration.test.ts",
)


def check_environment(environment, integration=False, environment_file=None):
    result = dict(environment)
    if environment_file:
        # crbn creates this only in the disposable CI checkout. Local tests use
        # explicitly exported test URLs, never an application's .env implicitly.
        if result.get("GITHUB_ACTIONS") != "true":
            raise ValueError("Environment-file loading is restricted to GitHub CI")
        for line in environment_file.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                words = shlex.split(value, comments=True)
                if len(words) > 1:
                    raise ValueError("Unsupported CI environment-file value")
                result[key] = words[0] if words else ""
        for key in DATABASE_KEYS:
            result[key] = result.get("SUPABASE_DB_URL", "")
    if integration:
        for key in DATABASE_KEYS:
            value = result.get(key, "")
            parsed = urlparse(value)
            if (
                parsed.scheme not in {"postgres", "postgresql"}
                or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
                or not parsed.path.strip("/")
            ):
                raise ValueError(f"Set {key} to an explicit isolated localhost database")
    else:
        for key in DATABASE_KEYS:
            result.pop(key, None)
    # No command in this gate contacts a paid model, bank, or mailbox.
    for key in ("MERCURY_API_TOKEN", "GMAIL_ACCOUNTS_JSON", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        result[key] = ""
    result["INVOICE_INTAKE_ENABLED"] = "false"
    return result


def commands(integration=False, erp_only=False):
    # Package Vitest configs import the built shared preset. A checkout with
    # only `pnpm install` has no dist/; do not depend on a previous dev build.
    result = [] if erp_only else [["pnpm", "--filter", "@carbon/config", "build"]]
    if integration:
        result.append(["pnpm", "--dir", "apps/erp", "exec", "vitest", "run", *ERP_DATABASE_TESTS])
        if not erp_only:
            result.append(["pnpm", "--filter", "@carbon/jobs", "exec", "vitest", "run", *JOBS_DATABASE_TESTS])
        return result
    result.append(["pnpm", "--dir", "apps/erp", "test:invoice"])
    if not erp_only:
        result.append([
            "pnpm", "--filter", "@carbon/jobs", "exec", "vitest", "run",
            "src/invoice-intake", "src/payment-sync",
            *[argument for test in JOBS_DATABASE_TESTS for argument in ("--exclude", test)],
        ])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--integration", action="store_true")
    parser.add_argument("--erp-only", action="store_true")
    parser.add_argument("--browser", action="store_true", help="After CI database checks, run synthetic browser acceptance")
    parser.add_argument("--environment", type=Path, help="CI-only crbn environment file")
    args = parser.parse_args()
    environment = check_environment(os.environ, args.integration, args.environment)
    if args.browser and (not args.integration or environment.get("GITHUB_ACTIONS") != "true"):
        raise ValueError("Use the standalone browser command locally; this combined mode is CI-only")
    for command in commands(args.integration, args.erp_only):
        subprocess.run(command, cwd=ROOT, env=environment, check=True)
    if args.browser:
        subprocess.run(["python3", "contrib/deploying/gcp-tailscale/check_invoice_browser.py", "--directory", "contrib/deploying/gcp-tailscale/.local/invoice-ci", "--start-app"], cwd=ROOT, env=environment, check=True)


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        raise SystemExit(str(error))
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.returncode)
