#!/usr/bin/env python3
"""Prepare/check/apply a private invoice manifest with the deployed immutable Ops image."""

import argparse
import copy
import fcntl
import json
from pathlib import Path
import re
import subprocess

RUNTIME = Path("/var/lib/carbon/runtime")
PRIVATE_ROOT = Path("/var/lib/carbon/invoice-operations")
LOADER = """
import {createRequire} from 'node:module';
const require=createRequire('/repo/apps/erp/package.json');
const {createServer}=await import(require.resolve('vite'));
const macros=await import(require.resolve('vite-plugin-babel-macros'));
const {lingui}=await import(require.resolve('@lingui/vite-plugin'));
const macroPlugin=typeof macros.default==='function'?macros.default:macros.default.default;
const server=await createServer({root:'/repo/apps/erp',configFile:false,plugins:[macroPlugin(),lingui()],
  resolve:{tsconfigPaths:true,alias:{canvas:'/repo/apps/erp/app/ssr-shims/canvas-stub.cjs'}},
  server:{middlewareMode:true},appType:'custom',logLevel:'error'});
try {
  const operation=await server.ssrLoadModule('/repo/apps/erp/app/modules/invoicing/invoice-operator.server.ts');
  await operation.runInvoiceOperator('/operator',process.env.INVOICE_OPERATOR_MODE);
} finally {await server.close();}
"""


def private_write(file, value):
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.touch(mode=0o600, exist_ok=True)
    temporary.chmod(0o600)
    temporary.write_text(json.dumps(value, indent=2))
    temporary.replace(file)


def private_read(file):
    if file.stat().st_mode & 0o077:
        raise ValueError("Private operator inputs must be mode 0600")
    return json.loads(file.read_text())


def prepare(directory, mode, runtime=RUNTIME, private_root=PRIVATE_ROOT):
    directory = directory.resolve()
    if not directory.is_relative_to(private_root.resolve()):
        raise ValueError("Use a private invoice-operations subdirectory")
    if directory.stat().st_mode & 0o077:
        raise ValueError("Operator directory must be mode 0700")
    config = private_read(directory / "operator.json")
    revision = (runtime / "revision").read_text().strip()
    if not re.fullmatch(r"[a-f0-9]{40}", revision) or not re.fullmatch(r"[a-f0-9]{40}", config.get("requiredRevision", "")):
        raise ValueError("Runtime and manifest revisions must be full commit identities")
    if mode != "recover" and config.get("requiredRevision") != revision:
        raise ValueError("Manifest must name the exact deployed revision")
    stack = copy.deepcopy(json.loads((runtime / "compose.json").read_text()))
    ops, erp = stack["services"]["ops"], stack["services"]["erp"]
    if ops["image"] != "carbon/ops:" + revision or erp["image"] != "carbon/erp:" + revision:
        raise ValueError("Runtime image tags do not match the deployed revision")
    ops["environment"] = {**erp["environment"], **ops["environment"],
        "INVOICE_OPERATOR_REVISION": revision, "INVOICE_OPERATOR_MODE": mode,
        "INVOICE_OPERATOR_SCHEDULER_PAUSED": "true" if mode != "check" else "false"}
    ops["secrets"] = list(dict.fromkeys([*erp.get("secrets", []), *ops.get("secrets", [])]))
    ops["volumes"].append({"type": "bind", "source": str(directory), "target": "/operator"})
    ops["working_dir"] = "/repo/apps/erp"
    ops["command"] = ["node", "--input-type=module", "-e", LOADER]
    return stack


def captured(command):
    return subprocess.check_output(command, text=True, stderr=subprocess.PIPE).strip()


def pin_images(stack, base):
    container = captured([*base, "ps", "-q", "erp"])
    if not container or "\n" in container:
        raise ValueError("Exactly one running ERP container is required")
    running = captured(["docker", "inspect", "--format", "{{.Image}}", container])
    erp = captured(["docker", "image", "inspect", "--format", "{{.Id}}", stack["services"]["erp"]["image"]])
    ops = captured(["docker", "image", "inspect", "--format", "{{.Id}}", stack["services"]["ops"]["image"]])
    if running != erp or not all(re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in (erp, ops)):
        raise ValueError("Running ERP does not match the deployed immutable image")
    stack["services"]["ops"]["image"] = ops


def run(directory, mode="check", execute=False, runtime=RUNTIME, private_root=PRIVATE_ROOT):
    stack = prepare(directory, mode, runtime, private_root)
    print("Prepared maintained invoice operator; no database or model operation has run.", flush=True)
    if not execute:
        return
    directory = directory.resolve()
    base = ["docker", "compose", "--project-name", "carbon", "--file", str(runtime / "compose.json")]
    with (private_root / "operator.lock").open("a") as lock:
        Path(lock.name).chmod(0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        pin_images(stack, base)
        compose = directory / "operator-compose.json"
        private_write(compose, stack)
        scheduler_file = directory / "scheduler.json"
        scheduler = private_read(scheduler_file) if scheduler_file.exists() else {"restoreRequired": False, "wasRunning": False}
        if scheduler["restoreRequired"] and mode != "recover":
            raise ValueError("Run recover before continuing an interrupted operation")
        log = directory / (mode + ".log")
        with log.open("w") as output:
            log.chmod(0o600)
            if mode != "check":
                if not scheduler["restoreRequired"]:
                    running = captured([*base, "ps", "--status", "running", "--services", "inngest"])
                    scheduler = {"restoreRequired": True, "wasRunning": "inngest" in running.splitlines()}
                    private_write(scheduler_file, scheduler)
                subprocess.run([*base, "stop", "inngest"], check=True, stdout=output, stderr=subprocess.STDOUT)
            result = subprocess.run(["docker", "compose", "--project-name", "carbon", "--file", str(compose), "--profile", "ops", "run", "--rm", "--no-deps", "--pull", "never", "ops"], stdout=output, stderr=subprocess.STDOUT)
            if mode != "check":
                checkpoint_file = directory / "checkpoint.json"
                pending = checkpoint_file.exists() and private_read(checkpoint_file).get("restoreRequired", True)
                if pending:
                    raise ValueError("Company settings need recovery; scheduler remains paused. Run recover and inspect private logs")
                if scheduler["wasRunning"]:
                    subprocess.run([*base, "start", "inngest"], check=True, stdout=output, stderr=subprocess.STDOUT)
                scheduler["restoreRequired"] = False
                private_write(scheduler_file, scheduler)
            if result.returncode:
                raise ValueError("Invoice operation failed; inspect its private log and checkpoint")
    print("Invoice operation finished; inspect private check/result artifacts.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--mode", choices=("check", "apply", "recover"), default="check")
    parser.add_argument("--execute", action="store_true", help="Execute the selected mode; apply may admit explicitly planned model calls")
    args = parser.parse_args()
    run(args.directory, args.mode, args.execute)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError):
        raise SystemExit("Invoice operator stopped. Inspect private inputs/logs and run recover after an interrupted apply; scheduler recovery may be required.")
