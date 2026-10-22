"""Supabase Storage: a patched storage-api, and a gateway narrowed to Carbon's use.

Two critical advisories (2026-10-14) affect the storage-api upstream pins:

- GHSA-8rrf-w776-x75g, fixed in 1.80.2: signed resumable (TUS) upload routes let
  a caller with no credentials create or overwrite any object. The signature
  check read the raw request URL while the router matched the decoded path, and
  the route writes with Storage's privileged database connection.
- GHSA-67rp-h2mf-ph72, fixed in 1.80.1: Storage's S3 protocol routes let the
  anon key read and write Iceberg table files.

Upstream's ``docker-compose.prod.yml`` and ``kong.yml`` stay unchanged; the
renderer adapts them here:

1. ``configure`` runs storage-api ``IMAGE`` unless upstream already pins a newer
   release. Storage migrates its own schema on start, and an older release
   cannot write to a schema a newer one has migrated (README: Supabase Storage),
   so a sync must never take it backwards.
2. ``configure`` turns off the S3 protocol, Iceberg and vector APIs, none of
   which Carbon uses.
3. ``configure_gateway`` puts ``auth/kong-storage-gate.lua`` in front of every
   gateway service that forwards to Storage, in every ingress mode: Kong refuses
   ``/storage/v1/s3*`` and signed resumable uploads, and resumable uploads
   without a bearer token (see that file). When the authz_api check is on, the
   gate runs first in that check's sandboxed ``pre-function``, so render.py
   configures the gateway after authz_api_claim.
"""

import re
import urllib.parse

IMAGE = "supabase/storage-api:v1.84.17"
PATCHED = (1, 80, 2)  # the later of the two advisories' fixed releases
PATTERN = re.compile(r"supabase/storage-api:v(\d+)\.(\d+)\.(\d+)")
# Storage reads these as booleans; only "false" means off for the S3 protocol.
DISABLED = {"S3_PROTOCOL_ENABLED": "false", "ICEBERG_ENABLED": "false", "VECTOR_ENABLED": "false"}
SOURCE = "contrib/deploying/gcp-tailscale/auth/kong-storage-gate.lua"
PLUGIN = "pre-function"
# Plugins that may sit on a gated service: the gate itself and upstream's cors,
# which neither rewrites the path nor answers before the gate (preflights only).
ALLOWED = {"cors", PLUGIN}


def version(image):
    match = PATTERN.fullmatch(image or "")
    if not match:
        raise ValueError("Upstream's compose file pins an unrecognized Storage image; review storage_api.py")
    return tuple(int(part) for part in match.groups())


def configure(storage):
    """Pin a patched storage-api (never older than upstream's) and turn off unused APIs."""
    if version(storage.get("image")) < version(IMAGE):
        storage["image"] = IMAGE
    storage["environment"].update(DISABLED)


def configure_gateway(gateway, kong, repo):
    """Gate every gateway service that forwards to Storage; refuse a gateway it cannot judge."""
    source = (repo / SOURCE).read_text()
    if any(plugin.get("name") == PLUGIN for plugin in gateway.get("plugins", [])):
        raise ValueError(f"The gateway configures a global {PLUGIN}; review the storage gate")
    gated = 0
    for service in gateway["services"]:
        target = urllib.parse.urlsplit(service.get("url", ""))
        if target.hostname != "storage" and service.get("host") != "storage":
            continue
        name = service.get("name", "")
        # The gate judges the forwarded path relative to Storage's root.
        if not service.get("url") or target.path not in ("", "/"):
            raise ValueError(f"Gateway service {name} forwards to Storage in a form the storage gate cannot judge")
        for route in service.get("routes", []):
            if route.get("plugins"):
                raise ValueError(f"Gateway route {route.get('name', '')} configures route-level plugins; they would run instead of the storage gate")
        plugins = service.setdefault("plugins", [])
        unexpected = sorted({plugin.get("name") for plugin in plugins} - ALLOWED)
        if unexpected:
            raise ValueError(f"Gateway service {name} configures {', '.join(unexpected)}; review the storage gate")
        existing = [plugin for plugin in plugins if plugin.get("name") == PLUGIN]
        if existing:
            existing[0].setdefault("config", {}).setdefault("access", []).insert(0, source)
        else:
            plugins.append({"name": PLUGIN, "config": {"access": [source]}})
        gated += 1
    if not gated:
        raise ValueError("No gateway service forwards to Storage; the storage gate has nothing to guard")
    environment = kong["environment"]
    if PLUGIN not in environment["KONG_PLUGINS"].split(","):
        environment["KONG_PLUGINS"] += "," + PLUGIN
    environment["KONG_UNTRUSTED_LUA"] = "sandbox"
