#!/usr/bin/env python3
"""Check real Docker ignore semantics using only disposable synthetic inputs.

No repository contents, credentials, containers, or database services enter these
builds. FROM scratch needs no image download; a local export exposes the actual
context selected by Docker, including Dockerfile-specific ignore precedence.
"""

import json
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[3]
PRIVATE_PATHS = (
    ".env.staging",
    ".envrc",
    ".local/private.json",
    ".fork/local/private.json",
    ".terraform/providers/provider",
    "terraform.tfstate.backup",
    ".terraform.tfstate.lock.info",
    "release.tfplan",
    "release.tfplan.json",
    "tfplan",
    "production.auto.tfvars",
    "production.tfvars.json",
    ".terraformrc",
    "terraform.rc",
    "credentials.tfrc.json",
    "crash.log",
    ".docker/config.json",
    ".buildx/cache/index.json",
    ".buildkit/cache/index.json",
    ".docker-build/image.tar",
    ".docker-cache/index.json",
    ".docker-images/image.tar",
    ".docker-data/volume/data",
    "release.docker.tar",
    "release.oci.tar.zst",
    ".secrets/token",
    "secrets/token",
    "runtime.secret",
    ".cert/key.pem",
    "__pycache__/module.pyc",
    "cache.pyc",
    "test-results/report.json",
    "playwright-report/report.html",
    ".codex/runtime.json",
    ".mcp.json",
)
PUBLIC_PATHS = (
    "infra/main.tf",
    "infra/main.tf.json",
    "infra/.terraform.lock.hcl",
    "infra/production.tfvars.example",
    "infra/production.tfvars.json.example",
    "infra/compose.local.yaml",
    "infra/Dockerfile.web",
    "infra/secrets.example.json",
    "infra/fixtures/example.tar",
    "apps/assembler/src/context-fixture.rs",
    "crates/context-fixture/src/lib.rs",
    "Cargo.toml",
    "Cargo.lock",
)


class ContextViolation(ValueError):
    def __init__(self, label, leaked, missing):
        self.private_count = len(leaked)
        super().__init__(
            f"{label}: {len(leaked)} private fixture paths included; "
            f"{len(missing)} source fixture paths excluded"
        )


def local_docker():
    result = subprocess.run(
        ["docker", "context", "inspect"], text=True, capture_output=True, check=True
    )
    endpoint = json.loads(result.stdout)[0]["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://"):
        raise ValueError(
            "Context proof requires an existing local Unix-socket Docker builder"
        )
    return ["docker", "--host", endpoint, "buildx", "build", "--builder", "default"]


def check_context(command, label, rules, *, kind="root"):
    with tempfile.TemporaryDirectory(prefix="carbon-context-fixture-") as temporary:
        root = Path(temporary)
        repository = root / "context"
        context = repository / "apps/assembler" if kind == "occt" else repository
        output = root / "output"
        context.mkdir(parents=True)
        prefixes = ("", "apps/assembler/fixtures/", "crates/context-fixture/")
        if kind == "occt":
            prefixes = ("", "occt-patches/fixtures/", "src/fixtures/")
        elif kind == "root":
            prefixes += ("contrib/deploying/knowledge/",)
        private = {prefix + path for prefix in prefixes for path in PRIVATE_PATHS}
        public = set(PUBLIC_PATHS)
        if kind == "occt":
            public.update(
                (
                    "occt-patches/apply.sh",
                    "occt-patches/example.patch",
                    "occt-patches/example.cxx",
                    "occt-patches/example.hxx",
                    "src/context-fixture.cpp",
                    "Dockerfile",
                    "occt.Dockerfile",
                )
            )
        elif kind == "root":
            public.update(
                "contrib/deploying/knowledge/" + path
                for path in (
                    "main.tf",
                    ".terraform.lock.hcl",
                    "production.tfvars.example",
                    "production.tfvars.json.example",
                    "compose.local.yaml",
                    "Dockerfile.web",
                )
            )
        for path in private | public:
            destination = context / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text("synthetic context fixture\n")
        if kind == "assembler":
            # An opposing root rule proves Docker actually selects the override.
            (context / ".dockerignore").write_text("**\n")
            dockerfile = context / "apps/assembler/Dockerfile"
            dockerfile.with_name("Dockerfile.dockerignore").write_text(rules)
        elif kind == "occt":
            # These opposing rules are outside the OCCT context or belong to a
            # different Dockerfile. Only the nested context's .dockerignore applies.
            (repository / ".dockerignore").write_text("**\n")
            (context / "Dockerfile.dockerignore").write_text("**\n")
            (context / ".dockerignore").write_text(rules)
            dockerfile = context / "occt.Dockerfile"
        elif kind == "root":
            (context / ".dockerignore").write_text(rules)
            dockerfile = context / "Dockerfile.context"
        else:
            raise ValueError("Unknown Docker context fixture")
        dockerfile.write_text("FROM scratch\nCOPY . /\n")
        result = subprocess.run(
            [
                *command,
                "--progress=quiet",
                "--network=none",
                "--output",
                f"type=local,dest={output}",
                "-f",
                str(dockerfile),
                str(context),
            ],
            text=True,
            capture_output=True,
        )
        if result.returncode:
            raise ValueError(
                f"{label}: synthetic context build failed (exit {result.returncode})"
            )
        leaked = sorted(path for path in private if (output / path).exists())
        missing = sorted(path for path in public if not (output / path).is_file())
        if leaked or missing:
            raise ContextViolation(label, leaked, missing)


def main():
    command = local_docker()
    root_rules = (ROOT / ".dockerignore").read_text()
    check_context(command, "root", root_rules)
    check_context(
        command,
        "assembler override",
        (ROOT / "apps/assembler/Dockerfile.dockerignore").read_text(),
        kind="assembler",
    )
    nested_rules = ROOT / "apps/assembler/.dockerignore"
    check_context(
        command,
        "OCCT nested context",
        nested_rules.read_text() if nested_rules.exists() else "",
        kind="occt",
    )
    # Docker's final match wins. Keep a negative control for future rule reorderings.
    try:
        check_context(
            command,
            "negative order control",
            root_rules + "\n!contrib/deploying/knowledge/**\n",
        )
    except ContextViolation as error:
        if not error.private_count:
            raise
    else:
        raise ValueError("Context fixture failed to detect a private-path re-inclusion")
    print(
        "Docker context proof passed: root + assembler + OCCT, source retained, unsafe re-inclusion rejected"
    )


if __name__ == "__main__":
    main()
