"""PostgreSQL settings and WAL-G archiving for INGRESS_MODE=private-lb.

The owning platform's data plane fixes the PostgreSQL settings and the archive
contract; tailscale mode renders nothing from this module. WAL-G archives every
WAL segment to ``gs://<PROJECT_ID>-pg-wal`` and takes a daily base backup. That
bucket belongs to the owning deployment, which grants SERVICE_ACCOUNT object
create and read only, under a retention policy: nothing here creates the bucket
or holds a key. WAL-G finds the account's token on the metadata server.

The image's userland is musl, but WAL-G's PostgreSQL release binary is linked
against glibc. ``wal-g-glibc.sh`` is mounted as ``/usr/local/bin/wal-g`` and runs
the pinned binary with a glibc loader from the image's Nix store, which is where
PostgreSQL's own glibc lives.

``python3 wal_g.py install`` (bootstrap, as root) downloads the pinned release and
refuses any other bytes. ``python3 wal_g.py units DIRECTORY`` writes the daily
base-backup timer.
"""

import hashlib
import os
from pathlib import Path
import sys
import tempfile
import urllib.request

import private_lb

# WAL-G's PostgreSQL build for linux/amd64 (the VM is e2-standard-4). The
# Ubuntu 20.04 build needs only glibc 2.29 symbols from libc, libm, libpthread
# and libresolv. The digest is the release's published .sha256 file.
VERSION = "v3.0.9"
ASSET = "wal-g-pg-20.04-amd64"
URL = f"https://github.com/wal-g/wal-g/releases/download/{VERSION}/{ASSET}"
SHA256 = "965a7147852435bc4b54f272799b63df826b54ef65cf7c4fc688c82b96c0c4eb"
MAX_BYTES = 128 << 20

# Container paths. The wrapper is on the image's PATH, so archive_command can
# name it as `wal-g`.
WRAPPER = "/usr/local/bin/wal-g"
BINARY = "/usr/local/lib/carbon-wal-g/wal-g"
PGDATA = "/var/lib/postgresql/data"
METADATA_HOST = "169.254.169.254"

MEMORY_LIMIT = "4g"
# Every value is passed on the command line, which takes precedence over
# postgresql.conf and the ALTER SYSTEM values the first initialization wrote.
# ssl=on comes from the private listener (private_postgres.configure).
SETTINGS = (
    "max_connections=200",
    "shared_buffers=1GB",
    "effective_cache_size=3GB",
    "work_mem=8MB",
    "maintenance_work_mem=256MB",
    "wal_level=logical",
    "password_encryption=scram-sha-256",
    "archive_mode=on",
    # Fails closed: any WAL-G error is non-zero, so PostgreSQL keeps the
    # segment and retries. Nothing is ever archived to /dev/null.
    "archive_command=wal-g wal-push %p",
    "archive_timeout=60s",
)

UNITS = ("carbon-wal-g-backup.service", "carbon-wal-g-backup.timer")
BACKUP_HELPER = "/usr/local/sbin/carbon-wal-g-backup"


def bucket(config):
    """The archive bucket, named after the project like the shared address and disk."""
    return config["PROJECT_ID"] + "-pg-wal"


def environment(config):
    """The WAL-G env file: settings only, never a credential."""
    return "\n".join((
        "# WAL-G archive settings (no secrets; credentials come from the metadata server).",
        "WALG_GS_PREFIX=gs://" + bucket(config),
        "WALG_COMPRESSION_METHOD=zstd",
        "WALG_PREVENT_WAL_OVERWRITE=true",
        # The service account may create and read objects but never delete
        # them, and the bucket's retention policy forbids deletion anyway.
        # WAL-G's GCS uploader deletes its temporary chunk objects after
        # composing each object and retries every failure with exponential
        # backoff, 16 times by default (about half an hour per object). The
        # chunks stay until the bucket's lifecycle rule removes them.
        "GCS_MAX_RETRIES=3",
        # Each upload buffers a 50 MiB chunk inside the PostgreSQL container's
        # memory limit; the default concurrency of 16 could take 800 MiB.
        "WALG_UPLOAD_CONCURRENCY=2",
        # Detect GCE and fetch tokens by address, without a DNS lookup.
        "GCE_METADATA_HOST=" + METADATA_HOST,
    )) + "\n"


def binary_source(state):
    """The pinned binary on the data disk; the version in the path changes the mount."""
    return Path(state) / "wal-g" / VERSION / "wal-g"


def configure(config, postgres, repo, output, state, *, writer):
    """Add the platform settings, the WAL-G env file and mounts to PostgreSQL."""
    if not private_lb.enabled(config):
        return
    if "ssl=on" not in postgres["command"]:
        raise ValueError("INGRESS_MODE=private-lb requires the private PostgreSQL listener")
    for setting in SETTINGS:
        postgres["command"] += ["-c", setting]
    postgres["mem_limit"] = MEMORY_LIMIT
    env = Path(output) / "wal-g.env"
    writer(env, environment(config))
    postgres["env_file"] = [str(env)]
    postgres["volumes"] += [
        {"type": "bind", "source": str(Path(repo) / "contrib/deploying/gcp-tailscale/wal-g-glibc.sh"),
         "target": WRAPPER, "read_only": True},
        {"type": "bind", "source": str(binary_source(state)), "target": BINARY, "read_only": True},
    ]


def units():
    """The host's daily base backup at 07:00 UTC, and the unit that runs it on demand."""
    return {
        "carbon-wal-g-backup.service": f"""[Unit]
Description=WAL-G base backup of Carbon's PostgreSQL to its private archive
# No dependency on Docker: maintenance stops it for a disk snapshot.
After=docker.service
RequiresMountsFor=/var/lib/carbon

[Service]
Type=oneshot
ExecStart={BACKUP_HELPER}
TimeoutStartSec=6h
""",
        "carbon-wal-g-backup.timer": """[Unit]
Description=Daily WAL-G base backup of Carbon's PostgreSQL

[Timer]
OnCalendar=*-*-* 07:00:00 UTC
AccuracySec=1min
# A run missed while the VM was down starts at the next boot.
Persistent=true

[Install]
WantedBy=timers.target
""",
    }


def write_units(directory):
    directory = Path(directory)
    for name, content in units().items():
        path = directory / name
        path.write_text(content)
        path.chmod(0o644)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def install(state=Path("/var/lib/carbon"), *, opener=urllib.request.urlopen):
    """Install the pinned binary once; refuse a download or an installed file with other bytes.

    Returns True when it downloaded the binary.
    """
    target = binary_source(state)
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError(f"{target} is not a regular file; inspect it before deploying")
    if target.exists():
        if sha256(target) != SHA256:
            raise ValueError(f"Installed WAL-G at {target} does not match its pinned sha256; inspect it before deploying")
        target.chmod(0o755)
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=target.parent, prefix=".download-")
    try:
        digest, size = hashlib.sha256(), 0
        with os.fdopen(descriptor, "wb") as stream, opener(URL, timeout=60) as response:
            for block in iter(lambda: response.read(1 << 20), b""):
                size += len(block)
                if size > MAX_BYTES:
                    raise ValueError("WAL-G download exceeds its size limit; refusing it")
                digest.update(block)
                stream.write(block)
        if digest.hexdigest() != SHA256:
            raise ValueError(f"Downloaded WAL-G {VERSION} does not match its pinned sha256; refusing to install it")
        os.chmod(temporary, 0o755)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["install"]:
            print(f"Installed WAL-G {VERSION}." if install() else f"WAL-G {VERSION} is already installed.")
        elif len(sys.argv) == 3 and sys.argv[1] == "units":
            write_units(sys.argv[2])
        else:
            sys.exit("Usage: wal_g.py install | wal_g.py units SYSTEMD_DIRECTORY")
    except (ValueError, OSError) as exc:
        message = str(exc) if isinstance(exc, ValueError) else type(exc).__name__ + ": WAL-G installation failed"
        sys.exit(f"Cannot install WAL-G: {message}")
