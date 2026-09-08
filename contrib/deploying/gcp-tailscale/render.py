#!/usr/bin/env python3
"""Adapt the upstream self-host stack for a single private GCE host.

Requires the distribution's python3-yaml package. Configuration and rendered
files belong on the private data disk, never in the public source checkout.
"""

import base64
import copy
import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time

import yaml
import private_postgres
import payment_sync
import invoice_inference


def write_private(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.exists():
        path.chmod(0o600)
    path.write_text(content)
    path.chmod(0o600)


def secret_file(directory, name, value):
    path = directory / name
    if not path.exists():
        write_private(path, value)
    if not path.read_text().strip():
        raise ValueError(f"Secret file is empty: {name}")
    # Compose file-backed secrets retain source permissions. Supabase services
    # use different unprivileged UIDs; the parent directory remains root-only.
    path.chmod(0o444)
    return path.read_text().strip()


def initialize_secrets(config, directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    for group in (("postgres_password", "postgrest_db_uri"), ("jwt_secret", "anon_key", "service_role_key")):
        present = [(directory / name).exists() for name in group]
        if any(present) and not all(present):
            raise ValueError("Incomplete persistent secret set; restore the matching files from backup")
    password = secret_file(directory, "postgres_password", secrets.token_hex(24))
    if not re.fullmatch(r"[a-f0-9]{48}", password):
        raise ValueError("Persistent database password must retain its generated hexadecimal format")
    db_uri = f"postgres://authenticator:{password}@postgres:5432/postgres"
    if secret_file(directory, "postgrest_db_uri", db_uri) != db_uri:
        raise ValueError("Persistent Postgres secrets do not match")
    jwt = secret_file(directory, "jwt_secret", secrets.token_hex(32))

    def encode(value):
        return base64.urlsafe_b64encode(value).rstrip(b"=")

    for role in ("anon", "service_role"):
        body = {"role": role, "iss": "supabase", "iat": int(time.time()), "exp": int(time.time()) + 10 * 365 * 86400}
        token = encode(b'{"alg":"HS256","typ":"JWT"}') + b"." + encode(json.dumps(body).encode())
        token += b"." + encode(hmac.new(jwt.encode(), token, hashlib.sha256).digest())
        secret_file(directory, "anon_key" if role == "anon" else "service_role_key", token.decode())
    for name in ("session_secret", "inngest_signing_key", "inngest_event_key", "realtime_secret_key_base"):
        secret_file(directory, name, secrets.token_hex(32))
    secret_file(directory, "realtime_db_enc_key", secrets.token_hex(8))
    supplied_resend = config.get("RESEND_API_KEY")
    if supplied_resend:
        write_private(directory / "resend_api_key", supplied_resend)
    secret_file(directory, "resend_api_key", "re_self_host_disabled")
    for name in ("smtp_password", "saml_private_key"):
        secret_file(directory, name, "disabled")
    for key in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"):
        name = key.lower()
        if not (directory / name).exists() and not config.get(key):
            raise ValueError(f"Set {key} in the private config, or create secrets/{name}")
        if config.get(key):
            write_private(directory / name, config[key])
        secret_file(directory, name, config.get(key, ""))


def render(config, repo, output, state=Path("/var/lib/carbon")):
    """Write concrete Compose JSON, gateway policy and proxy configuration."""
    os.umask(0o077)
    private_postgres.validate(config)
    payment_sync.validate(config)
    repo, output = repo.resolve(), output.resolve()
    names = ("ERP_HOST", "MES_HOST", "SUPABASE_HOST", "AUTH_ALLOWED_GOOGLE_DOMAIN")
    for key in names:
        if not re.fullmatch(r"[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}", config.get(key, "")):
            raise ValueError(f"Invalid DNS name: {key}")
    if len({config[key] for key in names[:3]}) != 3:
        raise ValueError("ERP, MES and Supabase must use distinct hostnames")
    ip = ipaddress.ip_address(config["TAILSCALE_IP"])
    if ip.version != 4 or ip not in ipaddress.ip_network("100.64.0.0/10"):
        raise ValueError("TAILSCALE_IP must be this VM's Tailscale IPv4 address")
    revision = config.get("DEPLOY_REVISION", repo.name)
    if not re.fullmatch(r"[a-f0-9]{40,64}", revision):
        raise ValueError("DEPLOY_REVISION must be the immutable source revision")
    releases = config.get("RELEASE_PLAN", {}).get("services", {})
    if releases and not isinstance(releases, dict):
        raise ValueError("RELEASE_PLAN.services must be an object")
    app_releases = {}
    for app in ("erp", "mes"):
        selected = releases.get(app, {})
        if selected and not isinstance(selected, dict):
            raise ValueError(f"RELEASE_PLAN.services.{app} must be an object")
        app_revision = selected.get("source_commit", revision)
        source_url = selected.get("source_code_url", config["SOURCE_CODE_URL"])
        mount_path = selected.get("config_mount_path", "")
        image_digest = selected.get("image_digest", "")
        if not re.fullmatch(r"[a-f0-9]{40,64}", app_revision):
            raise ValueError(f"RELEASE_PLAN.services.{app}.source_commit must be immutable")
        if not isinstance(source_url, str) or not source_url.startswith("https://github.com/"):
            raise ValueError(f"RELEASE_PLAN.services.{app}.source_code_url must be a public source URL")
        if mount_path and not re.fullmatch(r"/var/lib/carbon/config/[a-f0-9]+\.json", mount_path):
            raise ValueError(f"RELEASE_PLAN.services.{app}.config_mount_path is invalid")
        if image_digest and not re.fullmatch(r"sha256:[a-f0-9]+", image_digest):
            raise ValueError(f"RELEASE_PLAN.services.{app}.image_digest is invalid")
        app_releases[app] = {"revision": app_revision, "source_url": source_url, "mount_path": mount_path, "image_digest": image_digest, "config_digest": selected.get("config_digest", "")}
    # The session cookie contains credentials. Share it only across the closest
    # common ERP/MES domain, independently of the Google Workspace email domain.
    common_labels = []
    for labels in zip(*(reversed(config[key].split(".")) for key in ("ERP_HOST", "MES_HOST"))):
        if len(set(labels)) != 1:
            break
        common_labels.append(labels[0])
    if len(common_labels) < 2:
        raise ValueError("ERP and MES must share a cookie domain")
    values = {
        **config,
        "CARBON_REPO": str(repo),
        "DOMAIN": ".".join(reversed(common_labels)),
        "ERP_URL": "https://" + config["ERP_HOST"],
        "MES_URL": "https://" + config["MES_HOST"],
        "SUPABASE_URL": "https://" + config["SUPABASE_HOST"],
        "CARBON_IMAGE_ERP": "carbon/erp:" + app_releases["erp"]["revision"],
        "CARBON_IMAGE_MES": "carbon/mes:" + app_releases["mes"]["revision"],
    }

    def expand(value):
        if isinstance(value, str):
            return re.sub(r"\$\{([A-Z0-9_]+)(?::-([^}]*))?\}", lambda m: str(values.get(m[1]) or m[2] or ""), value)
        if isinstance(value, list):
            return [expand(item) for item in value]
        if isinstance(value, dict):
            return {key: expand(item) for key, item in value.items()}
        return value

    source = repo / "contrib/deploying/simple-docker-caddy"
    stack = expand(yaml.safe_load((source / "docker-compose.prod.yml").read_text()))
    stack = {key: value for key, value in stack.items() if not key.startswith("x-")}
    stack["name"] = "carbon"
    services = stack["services"]
    # Admin APIs are deliberately absent from both the service set and gateway.
    del services["studio"], services["meta"]
    stack["networks"] = {"internal": {"driver": "bridge"}}
    for service in services.values():
        service.pop("deploy", None)
        service.pop("ports", None)
        service["restart"] = "unless-stopped"
        service["logging"] = {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}}
    private_postgres.configure(config, services["postgres"], output, state)
    directory = state / "secrets"
    initialize_secrets(config, directory)
    for app in ("erp", "mes"):
        env = services[app]["environment"]
        env.update({
            "CARBON_EDITION": "community", "AUTH_PROVIDERS": "google",
            "VERCEL_ENV": "production", "VERCEL_URL": config[app.upper() + "_HOST"],
            "POSTHOG_API_HOST": "https://" + config["ERP_HOST"],
            "POSTHOG_PROJECT_PUBLIC_KEY": "disabled",
            "INNGEST_BASE_URL": "http://inngest:8288/",
            "INNGEST_SERVE_HOST": "http://erp:3000",
            "DISABLE_RESEND": "" if config.get("RESEND_API_KEY") else "true", "RESEND_API_KEY": "__RESEND_API_KEY__",
            "RESEND_DOMAIN": config.get("RESEND_DOMAIN", config["AUTH_ALLOWED_GOOGLE_DOMAIN"]),
            "SOURCE_CODE_URL": app_releases[app]["source_url"],
            "BROWSERLESS_WS_URL": "ws://chrome:3000",
        })
        if "resend_api_key" not in services[app]["secrets"]:
            services[app]["secrets"].append("resend_api_key")
        services[app].setdefault("labels", {}).update({
            "com.carbon.release.config-mount": app_releases[app]["mount_path"],
            "com.carbon.release.image-digest": app_releases[app]["image_digest"],
            "com.carbon.release.config-digest": app_releases[app]["config_digest"],
        })
    payment_sync.configure(config, services["erp"], directory, write_private)
    invoice_inference.configure(config, services["erp"])
    # A 200 response alone is insufficient: ERP reports dependency failures in JSON.
    services["erp"]["healthcheck"]["test"] = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(b=>process.exit(b.status==='healthy'?0:1)).catch(()=>process.exit(1))"]

    auth = services["gotrue"]
    auth["secrets"] += ["google_client_id", "google_client_secret"]
    auth["environment"].update({
        "GOTRUE_EXTERNAL_GOOGLE_ENABLED": "true",
        "GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID": "__GOOGLE_CLIENT_ID__",
        "GOTRUE_EXTERNAL_GOOGLE_SECRET": "__GOOGLE_CLIENT_SECRET__",
        "GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI": values["SUPABASE_URL"] + "/auth/v1/callback",
        "GOTRUE_EXTERNAL_EMAIL_ENABLED": "false", "GOTRUE_EXTERNAL_PHONE_ENABLED": "false",
        "GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED": "false", "GOTRUE_EXTERNAL_AZURE_ENABLED": "false",
        "GOTRUE_SAML_ENABLED": "false", "GOTRUE_DISABLE_SIGNUP": "false",
        "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED": "true",
        "GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI": "pg-functions://postgres/carbon_private/google_domain_access_token",
    })
    auth["healthcheck"] = {"test": ["CMD", "wget", "-qO-", "http://127.0.0.1:9999/health"], "interval": "5s", "timeout": "5s", "retries": 30}
    # First boot must let GoTrue initialize auth.users before Carbon migrations.
    bootstrap = copy.deepcopy(auth)
    bootstrap["profiles"] = ["bootstrap"]
    bootstrap["environment"]["GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_ENABLED"] = "false"
    bootstrap["environment"].pop("GOTRUE_HOOK_CUSTOM_ACCESS_TOKEN_URI")
    bootstrap["environment"]["GOTRUE_EXTERNAL_GOOGLE_ENABLED"] = "false"
    bootstrap["environment"]["GOTRUE_DISABLE_SIGNUP"] = "true"
    services["gotrue-bootstrap"] = bootstrap

    realtime = services["realtime"]
    realtime["secrets"] += ["realtime_secret_key_base", "realtime_db_enc_key"]
    realtime["environment"].update({"SECRET_KEY_BASE": "__REALTIME_SECRET_KEY_BASE__", "DB_ENC_KEY": "__REALTIME_DB_ENC_KEY__"})
    edge = services["edge-runtime"]
    edge["secrets"].append("inngest_event_key")
    edge["environment"].update({"INNGEST_BASE_URL": "http://inngest:8288/", "INNGEST_EVENT_KEY": "__INNGEST_EVENT_KEY__", "BROWSERLESS_WS_URL": "ws://chrome:3000", "ERP_URL": values["ERP_URL"], "MES_URL": values["MES_URL"]})
    edge["volumes"][-1]["source"] = str(repo / "contrib/deploying/gcp-tailscale/auth/edge-main")
    services["inngest"]["command"] = ["inngest", "start", "--sqlite-dir", "/data", "--sdk-url", "http://erp:3000/api/inngest", "--poll-interval", "30"]
    services["inngest"]["healthcheck"] = {"test": ["CMD", "inngest", "alpha", "doctor", "healthcheck"], "interval": "10s", "timeout": "10s", "retries": 24}
    services["chrome"] = {"image": "browserless/chrome:1-puppeteer-21.3.6", "restart": "unless-stopped", "networks": ["internal"], "environment": {"TOKEN": "", "CONNECTION_TIMEOUT": "60000"}, "shm_size": "256m", "mem_limit": "1g"}
    services["ops"] = {
        "image": "carbon/ops:" + revision, "profiles": ["ops"], "networks": ["internal"],
        "entrypoint": ["/usr/local/bin/carbon-secrets-entrypoint.sh"],
        "volumes": [copy.deepcopy(services["erp"]["volumes"][0])],
        "secrets": ["postgres_password", "anon_key", "service_role_key"],
        "environment": {"PGSSLMODE": "disable", "PGPASSWORD": "__POSTGRES_PASSWORD__", "SUPABASE_URL": "http://kong:8000", "SUPABASE_ANON_KEY": "__ANON_KEY__", "SUPABASE_SERVICE_ROLE_KEY": "__SERVICE_ROLE_KEY__"},
        "working_dir": "/repo/packages/database",
    }
    gateway = yaml.safe_load((repo / "packages/dev/docker/kong.yml").read_text())
    gateway["services"] = [service for service in gateway["services"] if service["name"] not in ("meta", "auth-v1-sso")]
    write_private(output / "kong.yml", yaml.safe_dump(gateway, sort_keys=False))
    (output / "kong.yml").chmod(0o444)
    services["kong"]["volumes"][0]["source"] = str(output / "kong.yml")
    proxy = services["caddy"]
    proxy["ports"] = [{"target": 443, "published": "443", "host_ip": str(ip), "protocol": "tcp"}]
    proxy["environment"] = {}
    proxy["networks"] = {"internal": {"aliases": [config[key] for key in names[:3]]}}
    proxy["volumes"][0]["source"] = str(output / "Caddyfile")
    proxy["volumes"].append({"type": "bind", "source": str(state / "tls"), "target": "/tls", "read_only": True})
    blocks = ["{\n  auto_https off\n  servers {\n    protocols h1 h2\n  }\n}\n"]
    for key, upstream in (("ERP_HOST", "erp:3000"), ("MES_HOST", "mes:3000"), ("SUPABASE_HOST", "kong:8000")):
        blocks.append(f"https://{config[key]} {{\n  tls /tls/live/carbon/fullchain.pem /tls/live/carbon/privkey.pem\n  reverse_proxy {upstream}\n}}\n")
    write_private(output / "Caddyfile", "\n".join(blocks))
    (output / "Caddyfile").chmod(0o444)
    used = {name for service in services.values() for name in service.get("secrets", [])}
    stack["secrets"] = {name: {"file": str(directory / name)} for name in sorted(used)}
    write_private(output / "compose.json", json.dumps(stack, indent=2) + "\n")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit("Usage: render.py CONFIG_JSON REPO_PATH OUTPUT_DIR")
    try:
        render(json.loads(Path(sys.argv[1]).read_text()), Path(sys.argv[2]), Path(sys.argv[3]))
    except (ValueError, KeyError, OSError) as exc:
        sys.exit(f"Cannot render private stack: {exc}")
