#!/usr/bin/env python3
"""Prove the real Dockerfile keeps dependency layers across source-only changes.

Uses only synthetic workspaces and uniquely tagged task-owned images. No existing
containers, volumes, or build caches are removed.
"""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import time


ROOT = Path(__file__).resolve().parents[3]


def run(args, cwd):
    subprocess.run(args, cwd=cwd, check=True)


def verify():
    tag = f"carbon-selective-cache-proof:{time.time_ns()}"
    with tempfile.TemporaryDirectory(prefix="carbon-cache-proof-") as directory:
        context = Path(directory)
        for name in ("apps/erp", "apps/mes", "packages/shared", "patches", "scripts"):
            (context / name).mkdir(parents=True)
        root_package = {
            "name": "cache-proof",
            "private": True,
            "packageManager": json.loads((ROOT / "package.json").read_text())[
                "packageManager"
            ],
        }
        (context / "package.json").write_text(json.dumps(root_package))
        (context / "pnpm-workspace.yaml").write_text(
            "packages:\n  - apps/*\n  - packages/*\n"
        )
        (context / "turbo.json").write_text(
            '{"tasks":{"build":{"dependsOn":["^build"]}}}'
        )
        (context / ".npmrc").write_text("")
        (context / "lingui.config.js").write_text("module.exports = {};\n")
        for name in ("erp", "mes"):
            (context / f"apps/{name}/package.json").write_text(
                json.dumps(
                    {
                        "name": name,
                        "version": "1.0.0",
                        "private": True,
                        "dependencies": {"@synthetic/shared": "workspace:*"},
                    }
                )
            )
            (context / f"apps/{name}/source.js").write_text("export const value = 1;\n")
        (context / "packages/shared/package.json").write_text(
            json.dumps(
                {
                    "name": "@synthetic/shared",
                    "version": "1.0.0",
                    "private": True,
                }
            )
        )
        (context / "Dockerfile").write_text((ROOT / "Dockerfile").read_text())
        # Git is required by Turbo's workspace discovery; never stage private data.
        run(["git", "init", "--quiet"], context)
        run(
            [
                "corepack",
                "pnpm",
                "install",
                "--lockfile-only",
                "--ignore-scripts",
                "--no-frozen-lockfile",
            ],
            context,
        )

        def build(label):
            receipt = context / f"{label}.iid"
            run(
                [
                    "docker",
                    "build",
                    "--progress=plain",
                    "--target",
                    "deps",
                    "--build-arg",
                    "APP=erp",
                    "--iidfile",
                    str(receipt),
                    "--tag",
                    tag,
                    ".",
                ],
                context,
            )
            return receipt.read_text().strip()

        try:
            initial = build("initial")
            (context / "apps/erp/source.js").write_text("export const value = 2;\n")
            source_changed = build("source")
            if source_changed != initial:
                raise AssertionError(
                    "ERP source-only edit rebuilt the dependency image"
                )
            (context / "apps/mes/source.js").write_text("export const value = 3;\n")
            if build("unrelated") != initial:
                raise AssertionError(
                    "Unrelated MES source edit rebuilt ERP dependencies"
                )
            # A real workspace dependency change must invalidate the install stage.
            manifest = context / "apps/erp/package.json"
            value = json.loads(manifest.read_text())
            value["dependencies"] = {}
            manifest.write_text(json.dumps(value))
            run(
                [
                    "corepack",
                    "pnpm",
                    "install",
                    "--lockfile-only",
                    "--ignore-scripts",
                    "--no-frozen-lockfile",
                ],
                context,
            )
            if build("dependency") == initial:
                raise AssertionError(
                    "Removed workspace dependency reused the old dependency image"
                )
            print(
                "PASS actual Docker dependency cache: source reuse, unrelated app reuse, dependency invalidation",
                flush=True,
            )
        finally:
            subprocess.run(
                ["docker", "image", "rm", tag], check=False, stdout=subprocess.DEVNULL
            )


if __name__ == "__main__":
    os.environ["DOCKER_BUILDKIT"] = "1"
    verify()
