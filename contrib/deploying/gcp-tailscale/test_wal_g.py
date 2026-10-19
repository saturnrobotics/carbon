"""PostgreSQL settings and WAL-G archiving for INGRESS_MODE=private-lb, offline."""

import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE))
render = importlib.import_module("render")
runtime_inputs = importlib.import_module("runtime_inputs")
wal_g = importlib.import_module("wal_g")
from test_render import private_lb_config  # noqa: E402

SETTINGS = {
    "max_connections": "200", "shared_buffers": "1GB", "effective_cache_size": "3GB", "work_mem": "8MB",
    "maintenance_work_mem": "256MB", "wal_level": "logical", "password_encryption": "scram-sha-256",
    "archive_mode": "on", "archive_command": "wal-g wal-push %p", "archive_timeout": "60s",
}
ENVIRONMENT = """# WAL-G archive settings (no secrets; credentials come from the metadata server).
WALG_GS_PREFIX=gs://example-project-pg-wal
WALG_COMPRESSION_METHOD=zstd
WALG_PREVENT_WAL_OVERWRITE=true
GCS_MAX_RETRIES=3
WALG_UPLOAD_CONCURRENCY=2
GCE_METADATA_HOST=169.254.169.254
"""


def flags(command):
    """The -c settings of a PostgreSQL command line, in order."""
    return [command[index + 1] for index, argument in enumerate(command[:-1]) if argument == "-c"]


def tailscale_config(**extra):
    config = {key: value for key, value in private_lb_config().items()
              if key not in {"INGRESS_MODE", "NETWORK", "SUBNET", "SERVICE_ACCOUNT", "INGRESS_ALLOWLIST",
                             "POSTGRES_PRIVATE_IP", "POSTGRES_CLIENT_CIDRS"}}
    return {**config, "TAILSCALE_IP": "100.72.10.8", **extra}


class PrivateLbPostgresTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.output = self.state / "prepared"
        render.render(private_lb_config(), REPO, self.output, self.state)
        self.stack = json.loads((self.output / "compose.json").read_text())
        self.postgres = self.stack["services"]["postgres"]

    def test_postgres_runs_with_the_platform_settings(self):
        settings = flags(self.postgres["command"])
        self.assertEqual(settings[-len(SETTINGS):], [f"{key}={value}" for key, value in SETTINGS.items()])
        # The private listener's TLS precedes them; nothing is set twice.
        self.assertIn("ssl=on", settings[:-len(SETTINGS)])
        names = [setting.split("=", 1)[0] for setting in settings]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(self.postgres["mem_limit"], "4g")

    def test_archive_command_fails_closed(self):
        command = dict(setting.split("=", 1) for setting in flags(self.postgres["command"]))["archive_command"]
        self.assertEqual(command, "wal-g wal-push %p")
        for escape in ("/dev/null", "true", "||", ";", "&", "exit"):
            self.assertNotIn(escape, command)

    def test_env_file_names_the_archive_and_holds_no_credential(self):
        env = self.output.resolve() / "wal-g.env"
        self.assertEqual(self.postgres["env_file"], [str(env)])
        self.assertEqual(env.read_text(), ENVIRONMENT)
        self.assertEqual(env.stat().st_mode & 0o777, 0o444)
        # Settings only: no key file, token or password reaches the container this way.
        names = {line.split("=", 1)[0] for line in env.read_text().splitlines() if not line.startswith("#")}
        self.assertEqual(names, {"WALG_GS_PREFIX", "WALG_COMPRESSION_METHOD", "WALG_PREVENT_WAL_OVERWRITE",
                                 "GCS_MAX_RETRIES", "WALG_UPLOAD_CONCURRENCY", "GCE_METADATA_HOST"})
        # The bucket follows PROJECT_ID; no deployment value is tracked.
        other = {**private_lb_config(), "PROJECT_ID": "other-project",
                 "SERVICE_ACCOUNT": "carbon-vm@other-project.iam.gserviceaccount.com"}
        for rule in other["INGRESS_ALLOWLIST"]:
            rule["target"] = other["SERVICE_ACCOUNT"]
        _, files = render.render(other, REPO, self.output, self.state, materialize=False)
        self.assertIn("WALG_GS_PREFIX=gs://other-project-pg-wal\n", files[str(env)])

    def test_wal_g_is_mounted_read_only_at_fixed_paths(self):
        mounts = {volume["target"]: volume for volume in self.postgres["volumes"] if isinstance(volume, dict)}
        self.assertEqual(mounts["/usr/local/bin/wal-g"], {
            "type": "bind", "source": str(REPO.resolve() / "contrib/deploying/gcp-tailscale/wal-g-glibc.sh"),
            "target": "/usr/local/bin/wal-g", "read_only": True})
        self.assertEqual(mounts["/usr/local/lib/carbon-wal-g/wal-g"], {
            "type": "bind", "source": str(self.state / "wal-g/v3.0.9/wal-g"),
            "target": "/usr/local/lib/carbon-wal-g/wal-g", "read_only": True})
        self.assertTrue(os.access(HERE / "wal-g-glibc.sh", os.X_OK))

    def test_release_inputs_select_maintenance_for_archive_changes(self):
        def postgres_inputs(config):
            _, platform = runtime_inputs.materialize(config, REPO, {})
            return platform["services"]["postgres"], platform["unmounted_generated"]

        service, generated = postgres_inputs(private_lb_config())
        self.assertIn("contrib/deploying/gcp-tailscale/wal-g-glibc.sh", service["mounted"])
        self.assertTrue([path for path in generated if path.endswith("/var/lib/carbon/prepared/runtime-inputs/wal-g.env")])
        with patch.object(wal_g, "VERSION", "v9.9.9"):
            self.assertNotEqual(postgres_inputs(private_lb_config())[0]["definition"], service["definition"])
        with patch.object(wal_g, "SETTINGS", wal_g.SETTINGS[:-1]):
            self.assertNotEqual(postgres_inputs(private_lb_config())[0]["definition"], service["definition"])

    def test_requires_the_private_listener(self):
        with self.assertRaisesRegex(ValueError, "private PostgreSQL listener"):
            wal_g.configure(private_lb_config(), {"command": ["postgres"], "volumes": []}, REPO, self.output,
                            self.state, writer=lambda *args: None)


class TailscaleModeTests(unittest.TestCase):
    def test_tailscale_output_is_byte_identical_without_the_archive(self):
        for label, config in (("tailnet only", tailscale_config()),
                              ("private listener", tailscale_config(POSTGRES_PRIVATE_IP="10.73.0.2",
                                                                    POSTGRES_CLIENT_CIDRS=["10.81.0.0/26"]))):
            with self.subTest(label), tempfile.TemporaryDirectory() as temporary:
                state = Path(temporary)
                rendered = render.render(config, REPO, state / "prepared", state, materialize=False)
                with patch.object(render.wal_g, "configure") as hook:
                    without = render.render(config, REPO, state / "prepared", state, materialize=False)
                hook.assert_called_once()
                self.assertEqual(json.dumps(rendered, sort_keys=True), json.dumps(without, sort_keys=True))
                stack, files = rendered
                postgres = stack["services"]["postgres"]
                self.assertFalse({setting.split("=", 1)[0] for setting in flags(postgres["command"])} & set(SETTINGS))
                self.assertFalse({"env_file", "mem_limit"} & set(postgres))
                self.assertNotIn("wal-g", json.dumps(rendered))


class WrapperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.store = self.root / "store"
        script = (HERE / "wal-g-glibc.sh").read_text()
        self.assertIn("binary=" + wal_g.BINARY + "\n", script)
        self.assertIn("store=/nix/store\n", script)
        self.wrapper = self.root / "wal-g"
        self.wrapper.write_text(script.replace("binary=" + wal_g.BINARY, "binary=/opt/wal-g")
                                .replace("store=/nix/store", f"store='{self.store}'"))
        self.wrapper.chmod(0o755)

    def loader(self, relative, *, status=0, executable=True):
        path = self.store / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f'#!/bin/sh\nprintf "%s\\n" "$0" "$@"\nexit {status}\n')
        path.chmod(0o755 if executable else 0o644)
        return path

    def run_wrapper(self, *args):
        return subprocess.run(["sh", str(self.wrapper), *args], text=True, capture_output=True)

    def test_runs_the_binary_with_the_newest_glibc_loader(self):
        self.loader("aaaa-glibc-2.39-5/lib/ld-linux-x86-64.so.2")
        newest = self.loader("bbbb-glibc-2.40-218/lib/ld-linux-x86-64.so.2")
        self.loader("cccc-glibc-2.40-66/lib/ld-linux-x86-64.so.2")
        self.loader("dddd-glibc-2.40-66-bin/bin/ld.so")
        self.loader("eeee-glibc-2.41-1/lib/ld-linux-x86-64.so.2", executable=False)
        result = self.run_wrapper("wal-push", "pg_wal/000000010000000000000001")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), [
            str(newest), "--library-path", str(newest.parent), "--argv0", str(self.wrapper),
            "/opt/wal-g", "wal-push", "pg_wal/000000010000000000000001"])

    def test_failures_reach_postgresql(self):
        self.loader("aaaa-glibc-2.40-66/lib/ld-linux-aarch64.so.1", status=7)
        self.assertEqual(self.run_wrapper("wal-push", "pg_wal/x").returncode, 7)

    def test_an_image_without_glibc_fails(self):
        self.loader("aaaa-musl-1.2.5/lib/ld-musl-x86_64.so.1")
        result = self.run_wrapper("wal-push", "pg_wal/x")
        self.assertEqual(result.returncode, 1)
        self.assertIn("no glibc loader", result.stderr)
        self.assertEqual(result.stdout, "")


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.target = self.state / "wal-g" / wal_g.VERSION / "wal-g"

    def opener(self, content, calls):
        def fake(url, timeout):
            calls.append((url, timeout))
            return io.BytesIO(content)
        return fake

    def test_pins_one_release_build(self):
        self.assertRegex(wal_g.VERSION, r"^v[0-9]+\.[0-9]+\.[0-9]+$")
        self.assertEqual(wal_g.ASSET, "wal-g-pg-20.04-amd64")
        self.assertEqual(wal_g.URL, f"https://github.com/wal-g/wal-g/releases/download/{wal_g.VERSION}/{wal_g.ASSET}")
        self.assertRegex(wal_g.SHA256, r"^[0-9a-f]{64}$")

    def test_refuses_a_download_with_other_bytes(self):
        calls = []
        with self.assertRaisesRegex(ValueError, "does not match its pinned sha256; refusing"):
            wal_g.install(self.state, opener=self.opener(b"not the pinned release", calls))
        self.assertEqual(calls, [(wal_g.URL, 60)])
        self.assertFalse(self.target.exists())
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_refuses_an_oversized_download(self):
        with patch.object(wal_g, "MAX_BYTES", 4), self.assertRaisesRegex(ValueError, "size limit"):
            wal_g.install(self.state, opener=self.opener(b"12345", []))
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_installs_only_the_pinned_bytes_once(self):
        content = b"synthetic release"
        calls = []
        with patch.object(wal_g, "SHA256", hashlib.sha256(content).hexdigest()):
            self.assertTrue(wal_g.install(self.state, opener=self.opener(content, calls)))
            self.assertEqual(self.target.read_bytes(), content)
            self.assertEqual(self.target.stat().st_mode & 0o777, 0o755)
            self.assertFalse(wal_g.install(self.state, opener=self.opener(content, calls)))
        self.assertEqual(len(calls), 1)
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    def test_refuses_an_installed_binary_with_other_bytes(self):
        self.target.parent.mkdir(parents=True)
        self.target.write_bytes(b"replaced")
        calls = []
        with self.assertRaisesRegex(ValueError, "does not match its pinned sha256; inspect"):
            wal_g.install(self.state, opener=self.opener(b"", calls))
        self.assertEqual((calls, self.target.read_bytes()), ([], b"replaced"))
        self.target.unlink()
        self.target.symlink_to(self.state)
        with self.assertRaisesRegex(ValueError, "not a regular file"):
            wal_g.install(self.state, opener=self.opener(b"", calls))


class BackupTimerTests(unittest.TestCase):
    def test_daily_base_backup_at_seven_utc(self):
        units = wal_g.units()
        self.assertEqual(set(units), set(wal_g.UNITS))
        timer = units["carbon-wal-g-backup.timer"]
        self.assertIn("\nOnCalendar=*-*-* 07:00:00 UTC\n", timer)
        self.assertIn("\nPersistent=true\n", timer)
        self.assertIn("\nWantedBy=timers.target\n", timer)
        service = units["carbon-wal-g-backup.service"]
        self.assertIn("\nType=oneshot\n", service)
        self.assertIn("\nExecStart=/usr/local/sbin/carbon-wal-g-backup\n", service)
        # Starting a backup must never start a Docker that maintenance stopped.
        self.assertFalse([line for line in service.splitlines() if line.startswith(("Requires=", "Wants=", "BindsTo="))])

    def test_units_command_writes_both_units(self):
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run([sys.executable, str(HERE / "wal_g.py"), "units", directory], check=True)
            for name, content in wal_g.units().items():
                path = Path(directory) / name
                self.assertEqual(path.read_text(), content)
                self.assertEqual(path.stat().st_mode & 0o777, 0o644)


class BackupHelperTests(unittest.TestCase):
    def run_helper(self, containers, *, ready=True, docker_ok=True):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "calls.jsonl"
            (root / "docker").write_text(f"""#!{sys.executable}
import json, sys
with open({str(log)!r}, "a") as stream:
    stream.write(json.dumps(["docker", *sys.argv[1:]]) + "\\n")
if not {docker_ok!r}:
    sys.exit(1)
if sys.argv[1] == "ps":
    print({containers!r})
elif sys.argv[1:3] == ["exec", "c0ffee"] and sys.argv[3] == "pg_isready":
    sys.exit(0 if {ready!r} else 2)
""")
            (root / "sleep").write_text(f"#!/bin/sh\necho '[\"sleep\"]' >> '{log}'\n")
            for name in ("docker", "sleep"):
                (root / name).chmod(0o755)
            result = subprocess.run(["bash", str(HERE / "wal-g-backup.sh")], text=True, capture_output=True,
                                    env={**os.environ, "PATH": f"{root}{os.pathsep}{os.environ['PATH']}"})
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls

    def test_runs_backup_push_in_the_postgres_container(self):
        result, calls = self.run_helper("c0ffee")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            ["docker", "ps", "--filter", "label=com.docker.compose.project=carbon",
             "--filter", "label=com.docker.compose.service=postgres", "--filter", "status=running", "--quiet"],
            ["docker", "exec", "c0ffee", "pg_isready", "-q", "-h", "127.0.0.1"],
            ["docker", "exec", "--user", "postgres", "--env", "PGHOST=127.0.0.1", "--env", "PGUSER=supabase_admin",
             "c0ffee", "/usr/local/bin/carbon-secrets-entrypoint.sh", "wal-g", "backup-push", wal_g.PGDATA],
        ])

    def test_waits_then_refuses_without_one_ready_postgres(self):
        for label, kwargs in (("absent", {"containers": ""}), ("two", {"containers": "c0ffee\nbeef"}),
                              ("starting", {"containers": "c0ffee", "ready": False})):
            with self.subTest(label):
                result, calls = self.run_helper(**kwargs)
                self.assertEqual(result.returncode, 1)
                self.assertIn("no base backup was taken", result.stderr)
                self.assertEqual(calls.count(["sleep"]), 60)
                self.assertFalse(any("backup-push" in call for call in calls))

    def test_stopped_docker_fails_at_once(self):
        result, calls = self.run_helper("c0ffee", docker_ok=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([call[1] for call in calls], ["ps"])


class BootstrapTests(unittest.TestCase):
    def block(self):
        source = (HERE / "bootstrap.sh").read_text()
        start = source.index("if [[ $mode == private-lb ]]; then\n  # The owning platform's data plane")
        return source[start:source.index("touch /etc/carbon-bootstrap-v1", start)]

    def run_block(self, mode, *, python_fails=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            log = root / "calls.jsonl"
            stub = f"""#!{sys.executable}
import json, os, sys
with open({str(log)!r}, "a") as stream:
    stream.write(json.dumps([os.path.basename(sys.argv[0]), *sys.argv[1:]]) + "\\n")
name = os.path.basename(sys.argv[0])
if name == "python3" and sys.argv[2:3] == ["install"] and {python_fails!r}:
    sys.exit("Cannot install WAL-G: Downloaded WAL-G does not match its pinned sha256; refusing to install it")
if name == "dpkg-query":
    print("install ok installed", end="")
"""
            for name in ("python3", "install", "chmod", "systemctl", "dpkg-query", "curl", "apt-get"):
                (root / name).write_text(stub)
                (root / name).chmod(0o755)
            script = f"set -euo pipefail\nmode={mode}\nrelease=/var/lib/carbon/releases/{'a' * 40}\n" + self.block()
            result = subprocess.run(["bash", "-c", script], text=True, capture_output=True,
                                    env={**os.environ, "PATH": f"{root}{os.pathsep}/usr/bin:/bin"})
            calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return result, calls

    def test_installs_the_pinned_release_and_the_timer(self):
        tooling = f"/var/lib/carbon/releases/{'a' * 40}/contrib/deploying/gcp-tailscale"
        result, calls = self.run_block("private-lb")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls, [
            ["chmod", "755", tooling + "/wal-g-glibc.sh"],
            ["python3", tooling + "/wal_g.py", "install"],
            ["install", "-m", "0755", tooling + "/wal-g-backup.sh", "/usr/local/sbin/carbon-wal-g-backup"],
            ["python3", tooling + "/wal_g.py", "units", "/etc/systemd/system"],
            ["systemctl", "daemon-reload"],
            ["systemctl", "enable", "--now", "carbon-wal-g-backup.timer"],
            ["dpkg-query", "--show", "--showformat=${Status}", "google-cloud-ops-agent"],
        ])

    def test_a_mismatched_release_stops_bootstrap(self):
        result, calls = self.run_block("private-lb", python_fails=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match its pinned sha256", result.stderr)
        self.assertEqual([call[0] for call in calls], ["chmod", "python3"])

    def test_tailscale_mode_runs_none_of_it(self):
        result, calls = self.run_block("tailscale")
        self.assertEqual((result.returncode, calls), (0, []))

    def test_ops_agent_comes_from_googles_signed_repository(self):
        block = self.block()
        self.assertIn("curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg"
                      " -o /etc/apt/keyrings/google-cloud-ops-agent.asc", block)
        self.assertIn("deb [signed-by=/etc/apt/keyrings/google-cloud-ops-agent.asc] https://packages.cloud.google.com/apt"
                      " google-cloud-ops-agent-bookworm-2 main", block)
        self.assertIn("apt-get install -y google-cloud-ops-agent", block)


if __name__ == "__main__":
    unittest.main()
