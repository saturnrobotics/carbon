"""Own a short-lived IAP database tunnel without changing operator credentials."""

from __future__ import annotations

import configparser
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import tempfile
import time


def validate_tunnel(value):
    if not isinstance(value, dict) or set(value) != {"project", "zone", "instance", "remote_port"}:
        raise ValueError("operator_tunnel requires project, zone, instance and remote_port")
    for key, pattern in {
        "project": r"[a-z][a-z0-9-]{4,28}[a-z0-9]",
        "zone": r"[a-z]+-[a-z]+[0-9]-[a-z]",
        "instance": r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?",
    }.items():
        if not isinstance(value[key], str) or not re.fullmatch(pattern, value[key]):
            raise ValueError("Invalid operator_tunnel " + key)
    if (not isinstance(value["remote_port"], int) or isinstance(value["remote_port"], bool)) or not 1 <= value[
        "remote_port"
    ] <= 65535:
        raise ValueError("Invalid operator_tunnel remote_port")


def retarget_passfile(text, old_port, port):
    # Split only unescaped colons; preserve escaped host/password bytes verbatim.
    lines = []
    for line in text.splitlines(keepends=True):
        # Use a scanner instead: even runs of backslashes precede real separators.
        fields, start, escaped = [], 0, False
        for i, char in enumerate(line):
            if char == ":" and not escaped:
                fields.append(line[start:i])
                start = i + 1
            escaped = char == "\\" and not escaped
        fields.append(line[start:])
        if not line.startswith("#") and len(fields) == 5 and fields[1] == str(old_port):
            fields[1] = str(port)
            line = ":".join(fields)
        lines.append(line)
    return "".join(lines)


class OperatorConnection:
    def __init__(self, config, state: Path, log: Path, *, timeout=45, cwd=None):
        self.config, self.state, self.log = config, state, log
        self.cwd = Path(cwd or Path.cwd())
        self.timeout = timeout
        self.process = None
        self.temporary = None
        self.environment = None

    def path(self, value):
        path = Path(value).expanduser()
        return path if path.is_absolute() else self.cwd / path

    def check(self):
        if self.process is not None and self.process.poll() is not None:
            raise ValueError("Portal operator tunnel disconnected; inspect the private log and retry")

    def start(self):
        if "operator_tunnel" not in self.config:
            return None
        if self.environment is not None:
            self.check()
            return self.environment
        settings = self.config["operator_tunnel"]
        validate_tunnel(settings)
        source = self.path(os.environ.get("PGSERVICEFILE", str(Path.home() / ".pg_service.conf")))
        service = configparser.ConfigParser(interpolation=None)
        try:
            with source.open() as stream:
                service.read_file(stream)
        except (OSError, configparser.Error):
            raise ValueError(
                "Cannot read operator libpq service file; configure PGSERVICEFILE or ~/.pg_service.conf"
            ) from None
        name = self.config["pg_service"]
        if not service.has_section(name):
            raise ValueError("Configured operator libpq service is missing")
        original = dict(service[name])
        host = original.get("host", "")
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", host) or host in {"localhost", "127.0.0.1"}:
            raise ValueError("Operator service host must be the remote database TLS identity")
        if original.get("sslmode") != "verify-full":
            raise ValueError("Managed operator tunnel requires explicit sslmode=verify-full")
        if "service" in original:
            raise ValueError("Nested libpq services are not supported for the managed operator tunnel")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        self.temporary = tempfile.TemporaryDirectory(prefix="operator-", dir=self.state)
        directory = Path(self.temporary.name)
        # Preserve host for TLS and passfile matching; only TCP routing changes.
        selected = {**original, "hostaddr": "127.0.0.1", "port": str(port), "connect_timeout": "5"}
        for key in ("sslrootcert", "sslcert", "sslkey", "sslcrl", "sslcrldir"):
            if key in selected and selected[key] != "system":
                selected[key] = str(self.path(selected[key]))
        password_path = self.path(original.get("passfile", os.environ.get("PGPASSFILE", str(Path.home() / ".pgpass"))))
        if password_path.is_file():
            if password_path.stat().st_mode & 0o077:
                raise ValueError("Operator password file must be private (chmod 600)")
            password_copy = directory / "pgpass"
            password_copy.write_text(
                retarget_passfile(
                    password_path.read_text(), original.get("port", os.environ.get("PGPORT", "5432")), port
                )
            )
            password_copy.chmod(0o600)
            selected["passfile"] = str(password_copy)
        elif "passfile" in original:
            raise ValueError("Configured operator password file is missing")
        private_service = configparser.ConfigParser(interpolation=None)
        private_service[name] = selected
        path = directory / "pg_service.conf"
        with path.open("w") as stream:
            private_service.write(stream, space_around_delimiters=False)
        path.chmod(0o600)
        env = dict(os.environ, PGSERVICEFILE=str(path))
        args = [
            "gcloud",
            "compute",
            "ssh",
            settings["instance"],
            "--project",
            settings["project"],
            "--zone",
            settings["zone"],
            "--tunnel-through-iap",
            "--strict-host-key-checking=yes",
            "--quiet",
            "--",
            "-N",
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ExitOnForwardFailure=yes",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ForkAfterAuthentication=no",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ServerAliveCountMax=3",
            "-o",
            "ConnectTimeout=15",
            "-L",
            f"127.0.0.1:{port}:{host}:{settings['remote_port']}",
        ]
        print("Portal: starting private operator database tunnel", flush=True)
        with self.log.open("a") as log:
            self.process = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True
            )
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            self.check()
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    self.check()
                    self.environment = env
                    return env
            except OSError:
                time.sleep(0.1)
        raise ValueError("Portal operator tunnel did not become ready; inspect the private log and retry")

    def close(self):
        if self.process is not None:
            # gcloud, ssh and the IAP transport belong to this invocation only.
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.process.wait(timeout=5)
            self.process = None
        if self.temporary is not None:
            self.temporary.cleanup()
            self.temporary = None
        self.environment = None
