"""Patched platform images: upstream's pins raised past published advisories.

The 2026-10-22 security sweep found advisories against these upstream pins in
``simple-docker-caddy/docker-compose.prod.yml``:

- ``postgres`` 15.14 (supabase/postgres 15.14.1.112): the PostgreSQL 15.15 to
  15.19 security releases (CVE-2026-14662 to CVE-2026-14681 and others; for
  example CVE-2026-14664 in regular expressions, which PostgREST's ``match``
  filters reach, and CVE-2026-14669 in ``to_char``) and supautils
  GHSA-5pqj-rc76-r669, GHSA-v9vh-54vv-7vfg, GHSA-vxh6-6m4g-c39q and
  GHSA-xj9m-rx42-rfc7. 15.19.0.006 ships PostgreSQL 15.19 and supautils 3.4.4.
- ``realtime`` 2.89.0: GHSA-9vjf-j9f7-j42c (any broadcaster can forge protocol
  events, postgres_changes included, to every client on a channel),
  GHSA-rcr8-2525-4r7p and GHSA-2rcv-vpjw-5g6c (fixed in 2.146.0).
- ``edge-runtime`` 1.74.0: request-handling crashes fixed in 1.74.2 (baggage
  header) and 1.74.4 (malformed WebCrypto keys).
- ``redis`` and ``caddy`` float on ``7-alpine`` and ``2-alpine``, so the VM
  keeps whatever it pulled first. 7.4.11 fixes the Redis 7.4 advisories
  (CVE-2025-49844 and later); 2.11.7 includes CVE-2026-55458 (fixed in 2.11.5).

Upstream's compose file stays unchanged; ``configure`` raises each image to
``IMAGES`` unless upstream already pins a newer release. PostgreSQL, Realtime
and Storage migrate their own schemas on start, so a sync must never take them
backwards. Pinned by tag, as every Supabase service image here is: Docker lists
a digest-only pull without its tag, and docker_prune.py keeps images by tag.
"""

import re

IMAGES = {
    "postgres": "supabase/postgres:15.19.0.006",
    "realtime": "supabase/realtime:v2.147.1",
    "edge-runtime": "supabase/edge-runtime:v1.77.8",
    "redis": "redis:7.4.11-alpine",
    "caddy": "caddy:2.11.7-alpine",
}
# host-deploy.sh proves the running server is at least this (server_version_num).
POSTGRES_PATCHED = 150019
TAG = re.compile(r"v?(\d+(?:\.\d+)*)(?:-[a-z0-9.]+)?")


def parse(image):
    """Repository and numeric version of an image reference; unrecognized tags fail."""
    repository, _, tag = (image or "").partition("@")[0].rpartition(":")
    match = TAG.fullmatch(tag)
    if not repository or not match:
        raise ValueError(f"Unrecognized image reference {image!r}; review service_images.py")
    return repository, tuple(int(part) for part in match.group(1).split("."))


def configure(services):
    """Raise each pinned service to its patched image, never below upstream's own pin."""
    for name, image in IMAGES.items():
        repository, patched = parse(image)
        upstream_repository, upstream = parse(services[name].get("image"))
        if upstream_repository != repository:
            raise ValueError(f"Upstream's {name} image is {upstream_repository}, not {repository}; review service_images.py")
        # A floating tag (7-alpine) is compared with the release's same-length
        # prefix: 7 is raised to 7.4.11, a later 8 is upstream's to keep.
        if upstream <= patched[:len(upstream)]:
            services[name]["image"] = image
