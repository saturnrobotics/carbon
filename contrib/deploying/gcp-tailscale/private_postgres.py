"""Optional private PostgreSQL listener and persistent TLS material."""

import ipaddress
import os
from pathlib import Path
import subprocess
import tempfile


OPTIONAL_KEYS = {"POSTGRES_PRIVATE_IP", "POSTGRES_CLIENT_CIDRS"}
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(value) for value in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def validate(config):
    """Return a canonical listener address and allowed source networks, or None."""
    present = OPTIONAL_KEYS & config.keys()
    if not present:
        return None
    if present != OPTIONAL_KEYS:
        raise ValueError("Set POSTGRES_PRIVATE_IP and POSTGRES_CLIENT_CIDRS together")
    raw_ip, cidrs = config["POSTGRES_PRIVATE_IP"], config["POSTGRES_CLIENT_CIDRS"]
    if not isinstance(raw_ip, str):
        raise ValueError("POSTGRES_PRIVATE_IP must be an RFC1918 IPv4 address")
    try:
        address = ipaddress.IPv4Address(raw_ip)
    except ipaddress.AddressValueError:
        raise ValueError("POSTGRES_PRIVATE_IP must be an RFC1918 IPv4 address") from None
    if not any(address in network for network in PRIVATE_NETWORKS):
        raise ValueError("POSTGRES_PRIVATE_IP must be an RFC1918 IPv4 address")
    if not isinstance(cidrs, list) or not cidrs or len(cidrs) > 16:
        raise ValueError("POSTGRES_CLIENT_CIDRS must list 1–16 explicit private subnets")
    networks = []
    for cidr in cidrs:
        if not isinstance(cidr, str) or "/" not in cidr:
            raise ValueError("POSTGRES_CLIENT_CIDRS must contain canonical RFC1918 /24–/32 subnets")
        try:
            network = ipaddress.IPv4Network(cidr, strict=True)
        except ValueError:
            raise ValueError("POSTGRES_CLIENT_CIDRS must contain canonical RFC1918 /24–/32 subnets") from None
        if network.prefixlen < 24 or str(network) != cidr or not any(network.subnet_of(parent) for parent in PRIVATE_NETWORKS):
            raise ValueError("POSTGRES_CLIENT_CIDRS must contain canonical RFC1918 /24–/32 subnets")
        if any(network.overlaps(previous) for previous in networks):
            raise ValueError("POSTGRES_CLIENT_CIDRS must not contain duplicate or overlapping subnets")
        networks.append(network)
    return str(address), [str(network) for network in networks]


def openssl(*args, check=True):
    return subprocess.run(["openssl", *map(str, args)], check=check, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def certificates(directory, address):
    """Keep the CA stable; renew its server certificate on deploy before expiry."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    names = ("ca.crt", "ca.key", "server.crt", "server.key")
    present = [(directory / name).exists() for name in names]
    if any(present) and not all(present):
        raise ValueError("Incomplete private PostgreSQL TLS files; restore them from backup")
    for name in names:
        if (directory / name).exists():
            (directory / name).chmod(0o600)
    if all(present):
        openssl("verify", "-no_check_time", "-CAfile", directory / "ca.crt", directory / "server.crt")
        if openssl("x509", "-in", directory / "server.crt", "-noout", "-checkip", address, check=False).returncode:
            raise ValueError("Private PostgreSQL IP differs from its persistent certificate; review the address change")
        if openssl("x509", "-in", directory / "server.crt", "-noout", "-checkend", str(30 * 86400), check=False).returncode == 0:
            return
    with tempfile.TemporaryDirectory(prefix=".issue-", dir=directory) as temporary:
        work = Path(temporary)
        ca = directory if all(present) else work
        if not any(present):
            openssl("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650",
                    "-subj", "/CN=Private PostgreSQL CA", "-addext", "basicConstraints=critical,CA:TRUE",
                    "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", work / "ca.key", "-out", work / "ca.crt")
        if openssl("x509", "-in", ca / "ca.crt", "-noout", "-checkend", str(826 * 86400), check=False).returncode:
            raise ValueError("Private PostgreSQL CA needs planned renewal and client trust updates")
        openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256", "-subj", "/CN=Private PostgreSQL",
                "-keyout", work / "server.key", "-out", work / "server.csr")
        extensions = work / "extensions.cnf"
        extensions.write_text(f"subjectAltName=IP:{address}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
        openssl("x509", "-req", "-in", work / "server.csr", "-CA", ca / "ca.crt", "-CAkey", ca / "ca.key",
                "-set_serial", "0x" + os.urandom(16).hex(), "-days", "825", "-sha256", "-extfile", extensions,
                "-out", work / "server.crt")
        for name in names:
            if (work / name).exists():
                (work / name).chmod(0o600)
                os.replace(work / name, directory / name)


def configure(config, postgres, output, state):
    settings = validate(config)
    if settings is None:
        return
    address, cidrs = settings
    directory = state / "private-postgres"
    certificates(directory, address)
    runtime = "/run/carbon-private-postgres"
    source = "/run/carbon-private-postgres-source"
    # Run as the image's initial root user, then preserve its normal entrypoint
    # privilege drop. Never hardcode the PostgreSQL UID/GID across image updates.
    script = """#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Private PostgreSQL setup requires the image root entrypoint' >&2; exit 1; }
install -d -m 700 -o postgres -g postgres /run/carbon-private-postgres
install -m 600 -o postgres -g postgres /run/carbon-private-postgres-source/server.key /run/carbon-private-postgres/server.key
install -m 644 -o postgres -g postgres /run/carbon-private-postgres-source/server.crt /run/carbon-private-postgres/server.crt
cat > /run/carbon-private-postgres/pg_hba.conf <<'CARBON_HBA'
"""
    for cidr in cidrs:
        script += (f"hostnossl all all {cidr} reject\n"
                   f"hostssl postgres all {cidr} scram-sha-256\n"
                   f"host all all {cidr} reject\n"
                   f"host replication all {cidr} reject\n")
    script += """CARBON_HBA
cat /etc/postgresql/pg_hba.conf >> /run/carbon-private-postgres/pg_hba.conf
chown postgres:postgres /run/carbon-private-postgres/pg_hba.conf
chmod 600 /run/carbon-private-postgres/pg_hba.conf
exec "$@"
"""
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    wrapper = output / "private-postgres-entrypoint.sh"
    if wrapper.exists():
        wrapper.chmod(0o600)
    wrapper.write_text(script)
    wrapper.chmod(0o444)
    postgres["ports"] = [{"target": 5432, "published": "5432", "host_ip": address, "protocol": "tcp"}]
    postgres["tmpfs"] = [runtime + ":rw,noexec,nosuid,nodev,size=1m,mode=0700"]
    postgres["volumes"].append({"type": "bind", "source": str(wrapper), "target": source + "/entrypoint.sh", "read_only": True})
    for name in ("server.crt", "server.key"):
        postgres["volumes"].append({"type": "bind", "source": str(directory / name), "target": source + "/" + name, "read_only": True})
    postgres["command"] = ["sh", source + "/entrypoint.sh", *postgres["command"],
                           "-c", "ssl=on", "-c", "ssl_min_protocol_version=TLSv1.2",
                           "-c", "ssl_cert_file=" + runtime + "/server.crt",
                           "-c", "ssl_key_file=" + runtime + "/server.key",
                           "-c", "hba_file=" + runtime + "/pg_hba.conf"]
