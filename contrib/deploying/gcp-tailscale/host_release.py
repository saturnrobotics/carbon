"""Attest Docker local image IDs before any service is stopped or promoted.

These are local image configuration digests, not registry manifest digests.
Compose receives the inspected immutable ID and never resolves a mutable tag
when applying the prepared app release.
"""

import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def write_atomic(path, value, *, encode_json=True):
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".release-")
    try:
        with os.fdopen(fd, "w") as stream:
            if encode_json:
                json.dump(value, stream, indent=2, sort_keys=True)
            else:
                stream.write(value)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def attest(config_path, compose_path):
    config = json.loads(config_path.read_text())
    compose = json.loads(compose_path.read_text())
    plan = config["RELEASE_PLAN"]
    if set(plan.get("services", {})) != {"erp", "mes"}:
        raise ValueError(
            "Image preparation requires the complete managed app inventory"
        )
    if set(plan.get("build", {})) - set(plan["services"]):
        raise ValueError("Unknown app build selection")
    for name, service in plan["services"].items():
        source = service["source_commit"]
        if not re.fullmatch(r"[a-f0-9]{40,64}", source):
            raise ValueError("Invalid image source revision for " + name)
        building = name in plan.get("build", {})
        if building and source != config["DEPLOY_REVISION"]:
            raise ValueError(
                "Selected image build does not match candidate source for " + name
            )
        tag = "carbon/" + name + ":" + source
        try:
            result = subprocess.run(
                ["docker", "image", "inspect", "--format", "{{.Id}}", tag],
                check=True,
                capture_output=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError):
            raise ValueError(
                "Required local image is missing for "
                + name
                + "; recover it or prepare a verified rebuild"
            ) from None
        actual = result.stdout.strip()
        if not re.fullmatch(r"sha256:[a-f0-9]{64}", actual):
            raise ValueError(
                "Docker returned an invalid immutable image identity for " + name
            )
        if not building and service.get("image_digest") != actual:
            raise ValueError(
                "Reused image identity differs from its verified receipt for " + name
            )
        if building:
            service["image_digest"] = actual
            service["build_receipt"] = {
                "identity_kind": "docker-image-id",
                "build_fingerprint": service["fingerprints"]["build"],
                "image_digest": actual,
                "source_commit": source,
            }
        compose["services"][name]["image"] = actual
        compose["services"][name].setdefault("labels", {})[
            "com.carbon.release.image-digest"
        ] = actual
    # Neither file describes the active runtime; failure leaves it untouched.
    write_atomic(compose_path, compose)
    write_atomic(config_path, config)


def finalize(config_path, compose_path, manifest_path):
    """Publish success only after controller checks and fresh live app proof.

    The private lock makes the generation check and receipt publication one
    serialized operation. Applying a candidate never advances this baseline.
    """
    with (manifest_path.parent / ".release-manifest.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        config = json.loads(config_path.read_text())
        plan = config["RELEASE_PLAN"]
        previous = (
            json.loads(manifest_path.read_text())
            if manifest_path.exists()
            else {"generation": 0}
        )
        if previous.get("generation") != plan.get("expected_generation"):
            raise ValueError("Release manifest generation changed before finalization")
        if plan.get("generation") != plan["expected_generation"] + 1:
            raise ValueError("Invalid final release generation")
        if set(plan.get("services", {})) != {"erp", "mes"}:
            raise ValueError("Finalization requires the complete managed app inventory")
        compose = json.loads(compose_path.read_text())
        for name, service in plan["services"].items():
            expected_image = service.get("image_digest", "")
            expected_config = service.get("config_digest", "")
            if not isinstance(expected_image, str) or not re.fullmatch(
                r"sha256:[a-f0-9]{64}", expected_image
            ):
                raise ValueError("Missing verified image identity for " + name)
            active_service = compose.get("services", {}).get(name, {})
            if active_service.get("image") != expected_image:
                raise ValueError(
                    "Active Compose image differs from final receipt for " + name
                )
            active_config = active_service.get("labels", {}).get(
                "com.carbon.release.config-digest"
            )
            if not expected_config or active_config != expected_config:
                raise ValueError(
                    "Active Compose configuration differs from final receipt for "
                    + name
                )
            try:
                selected = subprocess.run(
                    [
                        "docker",
                        "ps",
                        "--filter",
                        "label=com.docker.compose.project=carbon",
                        "--filter",
                        "label=com.docker.compose.service=" + name,
                        "--quiet",
                    ],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout.split()
                if len(selected) != 1:
                    raise ValueError(
                        "Expected exactly one running container for " + name
                    )
                template = (
                    '{"image":{{json .Image}},"config":{{json (index .Config.Labels "com.carbon.release.config-digest")}},'
                    '"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}'
                )
                observed = json.loads(
                    subprocess.run(
                        ["docker", "inspect", "--format", template, selected[0]],
                        check=True,
                        capture_output=True,
                        text=True,
                    ).stdout
                )
            except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
                raise ValueError(
                    "Cannot verify running image and configuration for " + name
                ) from None
            if (
                observed.get("image") != expected_image
                or observed.get("config") != expected_config
            ):
                raise ValueError(
                    "Running image or configuration differs from final receipt for "
                    + name
                )
            if (
                observed.get("status") != "running"
                or observed.get("health") != "healthy"
            ):
                raise ValueError(
                    "Running service is not healthy at finalization: " + name
                )
        manifest = {"generation": plan["generation"], "services": plan["services"]}
        for key in (
            "maintenance_fingerprint",
            "maintenance_inputs",
            "prepared_source_commit",
            "input_owners",
        ):
            if key in plan:
                manifest[key] = plan[key]
        revision = config["DEPLOY_REVISION"]
        if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{40}", revision):
            raise ValueError("Final source revision must be immutable")
        # Preserve the operator-facing source pointer. The manifest remains the
        # sole successful baseline and is published last.
        write_atomic(manifest_path.parent / "revision", revision, encode_json=False)
        write_atomic(manifest_path, manifest)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 5 and sys.argv[1] == "finalize":
            finalize(Path(sys.argv[2]), Path(sys.argv[3]), Path(sys.argv[4]))
        elif len(sys.argv) == 3:
            attest(Path(sys.argv[1]), Path(sys.argv[2]))
        else:
            raise ValueError(
                "Usage: host_release.py CONFIG_JSON PREPARED_COMPOSE_JSON, or finalize CONFIG_JSON COMPOSE_JSON MANIFEST_JSON"
            )
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
