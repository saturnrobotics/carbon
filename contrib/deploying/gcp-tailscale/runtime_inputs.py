"""Fingerprint effective private runtime definitions without creating runtime state."""

import hashlib
from pathlib import Path

import release_plan
import render

APPS = {"erp", "mes"}


def materialize(config, repo, secret_versions):
    """Use the production renderer with captured writes and stable release paths.

    Actual source/image identity belongs to build receipts, not runtime settings.
    Persistent credentials are represented only by their observed content hashes.
    Certificates are managed independently; preview never reads or issues them.
    """
    secret_versions = dict(secret_versions)
    # initialize_secrets writes these supplied values before starting containers.
    # Fingerprint that desired value immediately, not the old observed file, so
    # the completed rotation does not select another identical maintenance run.
    for key in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY"):
        if config.get(key):
            secret_versions[key.lower()] = (
                "sha256:" + hashlib.sha256(config[key].strip().encode()).hexdigest()
            )
    repo = repo.resolve()
    state = Path("/var/lib/carbon")
    output = state / "prepared/runtime-inputs"
    preview = {
        **config,
        "DEPLOY_REVISION": "0" * 40,
        "SOURCE_CODE_URL": "https://github.com/example/carbon/tree/" + "0" * 40,
        "TAILSCALE_IP": config.get("TAILSCALE_IP", "100.64.0.1"),
        "RELEASE_PLAN": {},
    }
    stack, files = render.render(preview, repo, output, state, materialize=False)
    used_files = set()

    def normalize(value):
        if isinstance(value, str):
            return value.replace(str(repo), "$REPO")
        if isinstance(value, list):
            return [normalize(item) for item in value]
        if isinstance(value, dict):
            return {key: normalize(item) for key, item in value.items()}
        return value

    def service_inputs(name, service):
        mounted = {}
        for volume in service.get("volumes", []):
            if isinstance(volume, str) and volume.split(":", 1)[0] in stack.get(
                "volumes", {}
            ):
                # Named Docker volumes are state, not repository source. Their
                # definitions are fingerprinted with shared platform settings.
                continue
            if not isinstance(volume, dict):
                raise ValueError(
                    "Runtime mount ownership requires long syntax for " + name
                )
            if volume.get("type") == "volume":
                continue
            if volume.get("type") != "bind":
                raise ValueError("Unknown runtime mount kind for " + name)
            source = volume.get("source")
            if not isinstance(source, str) or not Path(source).is_absolute():
                raise ValueError(
                    "Runtime bind mount requires an owned absolute source for " + name
                )
            if source in files:
                used_files.add(source)
                mounted[normalize(source)] = release_plan.digest(files[source])
            elif Path(source).is_relative_to(repo):
                relative = str(Path(source).relative_to(repo))
                mounted[relative] = release_plan.repository_closure(repo, [relative])
            elif Path(source) not in {
                state / "tls",
                state / "private-postgres/server.crt",
                state / "private-postgres/server.key",
            }:
                raise ValueError("Unknown runtime bind mount ownership for " + name)
        versions = {}
        for name in service.get("secrets", []):
            source = stack["secrets"][name]["file"]
            if source in files:
                used_files.add(source)
                versions[name] = release_plan.digest(files[source])
            else:
                versions[name] = secret_versions.get(
                    name, "initialize-during-maintenance"
                )
        return {
            "definition": release_plan.digest(normalize(service)),
            "mounted": mounted,
            "secrets": versions,
        }

    services = {
        name: service_inputs(name, service)
        for name, service in stack["services"].items()
    }
    shared = {
        key: value for key, value in stack.items() if key not in {"services", "secrets"}
    }
    platform = {
        "services": {
            name: value for name, value in services.items() if name not in APPS
        },
        "shared": release_plan.digest(normalize(shared)),
        "unmounted_generated": {
            normalize(path): release_plan.digest(content)
            for path, content in files.items()
            if path not in used_files
        },
    }
    return {name: services[name] for name in sorted(APPS)}, platform
