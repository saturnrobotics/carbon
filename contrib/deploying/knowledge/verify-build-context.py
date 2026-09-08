#!/usr/bin/env python3
"""Prove the actual Docker context excludes synthetic private local inputs."""

from pathlib import Path
import secrets
import subprocess


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]


def main():
    suffix = secrets.token_hex(8)
    local = HERE / ".local"
    local.mkdir(exist_ok=True)
    probes = [
        local / f"context-probe-{suffix}.txt",
        HERE / f".env.context-probe-{suffix}",
        HERE / f"context-probe-{suffix}.secret",
        HERE / f"context-probe-{suffix}.tfstate",
    ]
    created = []
    try:
        for path in probes:
            with path.open("x") as file:
                created.append(path)
                file.write("synthetic build-context exclusion probe\n")
        checks = " && ".join(
            f"test ! -e /probe/{path.relative_to(HERE).as_posix()}"
            for path in probes
        )
        dockerfile = (
            "FROM node:22-alpine\n"
            "COPY contrib/deploying/knowledge /probe\n"
            f"RUN {checks}\n"
        )
        subprocess.run(
            ["docker", "build", "--progress=plain", "-f", "-", str(ROOT)],
            input=dockerfile, text=True, check=True,
        )
        print("Private local, environment, secret and state probes excluded")
    finally:
        for path in created:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
