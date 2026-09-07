#!/usr/bin/env python3
"""Run synthetic invoice browser acceptance against an explicit local stack."""

import argparse
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import time
from urllib.parse import urlparse
from urllib.request import urlopen
from uuid import uuid4

from check_invoice import ROOT, check_environment


def browser_environment(environment, directory, environment_file=None):
    result = check_environment(environment, True, environment_file)
    for key, schemes in (("ERP_URL", {"http"}), ("SUPABASE_URL", {"http"}), ("SUPABASE_DB_URL", {"postgres", "postgresql"}), ("REDIS_URL", {"redis"})):
        parsed = urlparse(result.get(key, ""))
        if parsed.scheme not in schemes or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValueError(f"Set {key} to an explicit isolated localhost service")
    if not result.get("SUPABASE_SERVICE_ROLE_KEY"):
        raise ValueError("Explicit local Supabase service credentials are required")
    directory = directory.resolve()
    if directory.exists():
        raise ValueError("Use a new artifact directory for each browser run")
    private_root = ROOT / "contrib/deploying/gcp-tailscale/.local"
    if result.get("GITHUB_ACTIONS") != "true" and not directory.is_relative_to(private_root):
        raise ValueError("Local browser artifacts must remain under the ignored .local directory")
    directory.mkdir(mode=0o700, parents=True)
    directory.chmod(0o700)
    result["INVOICE_BROWSER_DIRECTORY"] = str(directory)
    result["INVOICE_BROWSER_EMAIL"] = "invoice-browser-" + str(uuid4()) + "@example.com"
    result["DEV_BYPASS_EMAIL"] = result["INVOICE_BROWSER_EMAIL"]
    return result


def run(environment, directory, start_app=False):
    erp = urlparse(environment["ERP_URL"])
    app = None
    log = (directory / "browser.log").open("w")
    Path(log.name).chmod(0o600)
    try:
        if start_app:
            with socket.socket() as probe:
                if probe.connect_ex((erp.hostname, erp.port or 80)) == 0:
                    raise ValueError("The browser runner will not replace an existing application")
            app = subprocess.Popen(["pnpm", "--dir", "apps/erp", "exec", "react-router", "dev", "--host", "127.0.0.1", "--port", str(erp.port or 80)], cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        deadline = time.monotonic() + 180
        while True:
            try:
                with urlopen(environment["ERP_URL"] + "/login", timeout=5) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if (app and app.poll() is not None) or time.monotonic() >= deadline:
                raise ValueError("Local ERP did not become ready; inspect the private browser log")
            time.sleep(1)

        def fixture(phase):
            subprocess.run(["pnpm", "--dir", "apps/erp", "exec", "vitest", "run", "--config", "test/invoice-browser/vitest.config.ts"], cwd=ROOT, env={**environment, "INVOICE_BROWSER_PHASE": phase}, stdout=log, stderr=subprocess.STDOUT, check=True)

        def browser(script, phase):
            subprocess.run(["node", "apps/erp/test/invoice-browser/" + script + ".mjs", phase], cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT, check=True)

        fixture("bootstrap")
        fixture("seed")
        browser("review", "review")
        fixture("process_multiple")
        browser("review", "approve")
        fixture("verify")
        shutil.copyfile(directory / "invoice-browser-verification.json", directory / "draft-verification.json")
        (directory / "draft-verification.json").chmod(0o600)
        shutil.copyfile(directory / "invoice-browser-state.json", directory / "approved.json")
        (directory / "approved.json").chmod(0o600)
        fixture("seed")
        fixture("add_unreadable")
        browser("preservation", "initial")
        fixture("process_reparse")
        browser("preservation", "preserved")
        fixture("change_evidence")
        browser("preservation", "stale")
        browser("preservation", "edited_total")
        fixture("link_draft")
        browser("preservation", "merge")
        fixture("archive_original")
        browser("preservation", "archived")
        fixture("verify_preservation")
        print("Synthetic browser acceptance passed: Draft and explicit masters, idempotency, no ledger changes, preserved review, current evidence, merge coverage and archived preview.")
    finally:
        if app and app.poll() is None:
            os.killpg(app.pid, signal.SIGTERM)
            try:
                app.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(app.pid, signal.SIGKILL)
                app.wait()
        log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--environment", type=Path, help="CI-only crbn environment file")
    parser.add_argument("--start-app", action="store_true", help="Start and stop a new local ERP process on an unused port")
    args = parser.parse_args()
    if not args.start_app:
        raise ValueError("Use --start-app on an unused local port so the new synthetic login is scoped to this test process")
    environment = browser_environment(os.environ, args.directory, args.environment)
    run(environment, args.directory.resolve(), args.start_app)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        raise SystemExit(str(error) if isinstance(error, ValueError) else "Browser acceptance failed; inspect the private browser log")
