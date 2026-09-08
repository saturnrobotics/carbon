"""Gather release inputs without publishing source or modifying the remote host.

Artifacts contain content fingerprints, not secret values. They remain private
because even a service inventory and configuration fingerprints are operational
information. Unknown legacy state selects coordinated maintenance initialization.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

import invoice_inference
import payment_sync
import release_plan

APPS = ("erp", "mes")
APP_SECRETS = ("postgres_password", "jwt_secret", "anon_key", "service_role_key",
               "session_secret", "inngest_signing_key", "inngest_event_key", "resend_api_key")
HERE_REL = "contrib/deploying/gcp-tailscale/"
BUILD_PATHS = ["Dockerfile", ".dockerignore", "lingui.config.js", "patches", "scripts"]
RUNTIME_PATHS = [HERE_REL + name for name in ("render.py", "payment_sync.py", "invoice_inference.py")]
RUNTIME_PATHS += ["contrib/deploying/simple-docker-caddy/docker-compose.prod.yml",
                  "contrib/deploying/simple-docker-caddy/bin/secrets-entrypoint.sh"]
MAINTENANCE_PATHS = ["packages/database/supabase/migrations", "packages/database/supabase/functions",
                     "packages/database/supabase/config.toml", "packages/dev/docker",
                     HERE_REL + "bootstrap.sh", HERE_REL + "host-deploy.sh", HERE_REL + "private_postgres.py",
                     HERE_REL + "certificates.sh", HERE_REL + "private-client-isolation.sql",
                     HERE_REL + "auth/google-domain-hook.sql", HERE_REL + "auth/edge-main"]
COMMON_CONFIG = {"ERP_HOST", "MES_HOST", "SUPABASE_HOST", "AUTH_ALLOWED_GOOGLE_DOMAIN", "RESEND_DOMAIN"}
APP_CONFIG = COMMON_CONFIG | payment_sync.CONFIG_KEYS | invoice_inference.CONFIG_KEYS | payment_sync.SECRET_KEYS | {"RESEND_API_KEY"}
# Cloudflare/Tailscale enrollment credentials do not describe an app release.
OPERATOR_ONLY = {"CLOUDFLARE_API_TOKEN", "TAILSCALE_AUTH_KEY", "SOURCE_REPO_URL"}
BASE_DEFAULTS = {"NODE_IMAGE": "node:22", "NODE_SLIM_IMAGE": "node:22-slim"}

# Run on the VM as root. Only the manifest and content hashes leave the host;
# not the config file, environment variables or secret values. Missing files are
# distinguished from permission, parse and SSH failures by the exit status.
OBSERVE_SCRIPT = '''import hashlib, json
from pathlib import Path
root = Path('/var/lib/carbon')
p = root / 'runtime/release-manifest.json'
manifest = json.loads(p.read_text()) if p.exists() else {'generation': 0, 'services': {}}
versions = {}
directory = root / 'secrets'
if directory.exists():
    for path in directory.iterdir():
        if path.is_file():
            versions[path.name] = 'sha256:' + hashlib.sha256(path.read_text().strip().encode()).hexdigest()
print(json.dumps({'manifest': manifest, 'runtime_exists': (root / 'runtime/compose.json').is_file(), 'secret_versions': versions}))
'''


def secret_digest(value):
    return "sha256:" + hashlib.sha256(value.strip().encode()).hexdigest()


def observe(cloud):
    try:
        instances = cloud.get("compute", "instances", "list", "--zones", cloud.c["ZONE"],
                              "--filter", "name=" + cloud.c["VM_NAME"])
        if not instances:
            return {"manifest": {"generation": 0, "services": {}}, "runtime_exists": False, "secret_versions": {}}
        if len(instances) != 1:
            raise ValueError("Ambiguous deployment VM; cannot observe release state")
        result = json.loads(cloud.ssh("sudo", "python3", "-c", OBSERVE_SCRIPT, capture=True))
    except (subprocess.CalledProcessError, OSError, json.JSONDecodeError):
        raise ValueError("Unable to observe deployment state; check GCP login, IAP/SSH access and private VM files. No release was inferred from this failure.") from None
    manifest = result.get("manifest") if isinstance(result, dict) else None
    if (not isinstance(manifest, dict) or type(manifest.get("generation")) is not int
            or manifest["generation"] < 0 or not isinstance(manifest.get("services"), dict)
            or not isinstance(result.get("secret_versions"), dict) or type(result.get("runtime_exists")) is not bool):
        raise ValueError("Invalid observed release state; inspect the private VM manifest")
    return result


def resolve_base_images(repo):
    dockerfile = (repo / "Dockerfile").read_text()
    resolved = {}
    for key, expected in BASE_DEFAULTS.items():
        declaration = re.search(r"^ARG " + key + r"=(\S+)\s*$", dockerfile, re.M)
        if declaration is None or declaration[1] != expected:
            raise ValueError("Docker base declarations changed; update the release input resolver before deploying")
        try:
            result = subprocess.run(["docker", "buildx", "imagetools", "inspect", expected,
                                     "--format", "{{json .Manifest}}"], check=True, text=True, capture_output=True)
            digest = json.loads(result.stdout)["digest"]
        except (OSError, subprocess.CalledProcessError, ValueError, KeyError, TypeError):
            raise ValueError("Unable to resolve Docker base image digests; check Docker Buildx and registry access") from None
        if not isinstance(digest, str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise ValueError("Registry returned an invalid immutable base image digest")
        resolved[key] = expected + "@" + digest
    return resolved


def desired_release(config, repo, revision, observation, base_images):
    if not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Release preparation requires a Git commit identity")
    previous = observation["manifest"]
    unknown = set(previous.get("services", {})) - set(APPS)
    if unknown:
        raise ValueError("Existing manifest contains unsupported managed services; extend preparation before deploying")
    runtime_files = release_plan.repository_closure(repo, RUNTIME_PATHS)
    maintenance_files = release_plan.repository_closure(repo, MAINTENANCE_PATHS)
    # Shared renderer/template changes can affect infrastructure as well as apps.
    maintenance_config = {key: release_plan.digest(value) for key, value in config.items()
                          if key not in (APP_CONFIG | OPERATOR_ONLY) - (COMMON_CONFIG - {"RESEND_DOMAIN"})}
    maintenance_fingerprint = release_plan.digest({"source": maintenance_files,
        "renderer": runtime_files, "config": maintenance_config})
    reasons = []
    if not previous.get("maintenance_fingerprint"):
        reasons.append("Existing deployment has no verified maintenance baseline" if observation["runtime_exists"]
                       else "First installation requires a maintenance baseline")
    elif previous["maintenance_fingerprint"] != maintenance_fingerprint:
        reasons.append("Shared infrastructure, authentication or database inputs changed")
    desired = {"schema_version": 1, "generation": previous["generation"] + 1, "services": {},
               "prepared_source_commit": revision,
               "previous_runtime_exists": observation["runtime_exists"],
               "base_images": base_images, "maintenance_fingerprint": maintenance_fingerprint,
               "maintenance_required": bool(reasons), "maintenance_reasons": reasons}
    for name in APPS:
        selected = {key: config.get(key, "") for key in COMMON_CONFIG}
        selected["DISABLE_RESEND"] = not bool(config.get("RESEND_API_KEY"))
        versions = {}
        for secret in APP_SECRETS:
            supplied = config.get("RESEND_API_KEY") if secret == "resend_api_key" else None
            if supplied:
                versions[secret] = secret_digest(supplied)
            elif secret in observation["secret_versions"]:
                versions[secret] = observation["secret_versions"][secret]
            elif observation["runtime_exists"] and secret != "resend_api_key":
                raise ValueError("Persistent application secret is missing; restore the matching private secret set before deployment")
            else:
                # Not an invented version: first-install unknowns are explicitly
                # marked and cannot authorize a routine deployment.
                versions[secret] = "initialize-during-maintenance"
        if name == "erp":
            selected.update(invoice_inference.validate(config, project=config.get("PROJECT_ID")))
            selected.update({key: config.get(key, "") for key in payment_sync.CONFIG_KEYS})
            for key in payment_sync.SECRET_KEYS:
                selected[key + "_ENABLED"] = bool(config.get(key))
                if config.get(key):
                    versions[key.lower()] = secret_digest(config[key])
        desired["services"][name] = {
            "workspace": name, "task": "build", "build_paths": BUILD_PATHS,
            "source_commit": revision, "source_code_url": config["SOURCE_REPO_URL"] + "/tree/" + revision,
            "inputs": {"base_image_digest": release_plan.digest(base_images)},
            "runtime_config": {"inputs": {key: release_plan.digest(value) for key, value in selected.items()},
                               "renderer": runtime_files},
            "secret_versions": versions,
        }
    return release_plan.materialize_repository_inputs(desired, repo)


def plan_release(desired, previous):
    planned = release_plan.plan(desired, previous)
    for key in ("maintenance_fingerprint", "maintenance_required", "maintenance_reasons"):
        planned[key] = desired[key]
    return planned


def write_private_json(path, value):
    path = path.absolute()
    if path.is_symlink():
        raise ValueError("Refusing to overwrite a symlink for a private release artifact")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix=".release-")
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_artifact_path(repo, output):
    # Reject public/tracked paths and symlink escapes before collecting state.
    absolute = output.absolute()
    if any(path.is_symlink() for path in (absolute, *absolute.parents)):
        raise ValueError("Private release artifact paths must not contain a symlink")
    try:
        relative = absolute.relative_to(repo.resolve())
    except ValueError:
        raise ValueError("Generated release artifacts must stay in the deployment's ignored .local directory") from None
    tracked = subprocess.run(["git", "-C", str(repo), "ls-files", "--", str(relative)],
                             check=True, text=True, capture_output=True).stdout
    ignored = subprocess.run(["git", "-C", str(repo), "check-ignore", "-q", str(relative)]).returncode == 0
    if tracked or not ignored:
        raise ValueError("Generated release artifacts must be untracked and gitignored; use the deployment .local directory")


def prepare(config, repo, revision, cloud, output):
    preview = output.with_name("release-preview.json")
    validate_artifact_path(repo, output)
    validate_artifact_path(repo, preview)
    observation = observe(cloud)
    desired = desired_release(config, repo, revision, observation, resolve_base_images(repo))
    planned = plan_release(desired, observation["manifest"])
    write_private_json(output, desired)
    write_private_json(preview, planned)
    return desired, planned


def print_summary(planned):
    print("Release plan:")
    for key, label in (("build", "Build"), ("configure", "Reconfigure"), ("deploy", "Update"), ("unchanged", "Unchanged")):
        print("  " + label + ": " + (", ".join(sorted(planned[key])) or "none"))
    for reason in planned.get("maintenance_reasons", []):
        print("  Maintenance required: " + reason)
    if planned.get("maintenance_required"):
        print("  make deploy handles this automatically with a recovery snapshot before applying maintenance.")
