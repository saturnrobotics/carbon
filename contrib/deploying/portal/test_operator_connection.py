"""Exercise the real subprocess and TCP lifecycle with a synthetic IAP provider."""

import json
import os
from pathlib import Path
import signal
import socket
import sys
import tempfile
import subprocess
import time
import threading
import unittest
from unittest.mock import patch

from test_deploy import module
from test_deploy_preflight import configuration


class OperatorConnectionTests(unittest.TestCase):
    def setUp(self):
        self.deploy = module()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.trace = self.root / "trace.json"
        self.service = self.root / "service.conf"
        self.original = "[portal-observer]\nhost=192.0.2.5\nhostaddr=127.0.0.1\nport=63115\nsslmode=verify-full\nsslrootcert=/synthetic/ca.pem\npassfile=/synthetic/passfile\nuser=observer\ndbname=example\n"
        self.password = self.root / "password"
        self.password.write_text("192.0.2.5:63115:example:observer:synthetic\\:password\n")
        self.password.chmod(0o600)
        self.original = self.original.replace("/synthetic/passfile", str(self.password))
        self.service.write_text(self.original)
        self.config = configuration(self.deploy)
        self.config["operator_tunnel"] = dict(
            project="example-project", zone="us-east1-b", instance="example-vm", remote_port=5432
        )
        self.write_tool(
            "gcloud",
            """
import json, os, signal, socket, sys, time
from pathlib import Path
args=sys.argv[1:]
forward=args[args.index('-L')+1].split(':')
port=int(forward[1])
Path(os.environ['TRACE']).write_text(json.dumps(dict(pid=os.getpid(), args=args, port=port)))
if os.environ.get('FAKE_TUNNEL') == 'exit': sys.exit(7)
if os.environ.get('FAKE_TUNNEL') == 'stall': time.sleep(60)
s=socket.socket();s.bind(('127.0.0.1',port));s.listen()
while True:
 c,_=s.accept();c.close()
""",
        )
        self.write_tool(
            "psql",
            """
import configparser,json,os,socket,sys
from pathlib import Path
p=configparser.ConfigParser(interpolation=None);p.read(os.environ['PGSERVICEFILE'])
s=p['portal-observer']
assert s['host']=='192.0.2.5' and s['sslmode']=='verify-full'
assert s['sslrootcert']=='/synthetic/ca.pem'
assert Path(s['passfile']).read_text()=='192.0.2.5:'+s['port']+':example:observer:synthetic\\\\:password\\n'
with socket.create_connection((s['hostaddr'],int(s['port'])),timeout=1): pass
if os.environ.get('FAKE_SQL_FAIL'): sys.exit(2)
print('t')
""",
        )
        self.env = patch.dict(
            os.environ,
            {
                "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                "PGSERVICEFILE": str(self.service),
                "TRACE": str(self.trace),
            },
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def write_tool(self, name, script):
        p = self.root / name
        p.write_text("#!" + sys.executable + "\n" + script)
        p.chmod(0o700)

    def adapter(self):
        # This assertion is the original regression: the controller had no lifecycle.
        self.assertTrue(
            hasattr(self.deploy.Commands, "__enter__"), "Deployment adapter must own the operator connection lifecycle"
        )
        return self.deploy.Commands(self.root / "private.log", config=self.config, state=self.root)

    def query(self, adapter):
        return adapter.call(
            ["psql", "-X", "--no-password", "service=portal-observer", "-Atc", "SELECT 1"], capture=True
        )

    def assert_closed(self):
        receipt = json.loads(self.trace.read_text())
        with socket.socket() as s:
            self.assertNotEqual(s.connect_ex(("127.0.0.1", receipt["port"])), 0)
        with self.assertRaises(ProcessLookupError):
            os.kill(receipt["pid"], 0)
        self.assertEqual(self.service.read_text(), self.original)
        self.assertFalse(list(self.root.glob("operator-*")))

    def test_connection_is_owned_reused_and_cleaned_up(self):
        for retry in (0, 1):
            with self.subTest(retry=retry):
                with self.adapter() as adapter:
                    self.assertEqual(self.query(adapter).strip(), "t")
                    first = json.loads(self.trace.read_text())
                    self.query(adapter)
                    self.assertEqual(json.loads(self.trace.read_text())["pid"], first["pid"])
                    self.assertNotEqual(first["port"], 63115)
                    self.assertIn("StrictHostKeyChecking=yes", first["args"])
                self.assert_closed()

    def test_failure_and_interrupt_cleanup(self):
        for failure in (ValueError("synthetic failure"), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                with self.assertRaises(type(failure)):
                    with self.adapter() as adapter:
                        self.query(adapter)
                        raise failure
                self.assert_closed()

    def test_no_tunnel_before_a_database_command(self):
        with self.adapter():
            pass
        self.assertFalse(self.trace.exists())

    def test_provider_exit_stops_before_sql_and_cleans_up(self):
        with patch.dict(os.environ, {"FAKE_TUNNEL": "exit"}):
            with self.assertRaisesRegex(ValueError, "tunnel"):
                with self.adapter() as adapter:
                    self.query(adapter)
        self.assert_closed()

    def test_dead_tunnel_is_not_silently_reused(self):
        with self.assertRaisesRegex(ValueError, "tunnel"):
            with self.adapter() as adapter:
                self.query(adapter)
                os.kill(json.loads(self.trace.read_text())["pid"], signal.SIGTERM)
                time.sleep(0.1)
                self.query(adapter)
        self.assert_closed()

    def test_config_accepts_only_structured_tunnel_inputs(self):
        self.deploy.validate_config(self.config)
        for field, value in [("instance", "--command=unsafe"), ("remote_port", True), ("project", "bad;command")]:
            with self.subTest(field=field):
                self.config["operator_tunnel"][field] = value
                with self.assertRaises(ValueError):
                    self.deploy.validate_config(self.config)
                self.config["operator_tunnel"] = dict(
                    project="example-project", zone="us-east1-b", instance="example-vm", remote_port=5432
                )

    def test_tls_weakening_is_refused(self):
        self.service.write_text(self.original.replace("verify-full", "require"))
        with self.assertRaisesRegex(ValueError, "verify-full"):
            with self.adapter() as adapter:
                self.query(adapter)
        self.assertFalse(self.trace.exists())

    def test_main_opens_connection_for_check_and_apply_and_cleans_up(self):
        config_path = self.root / "deploy.json"
        config_path.write_text(json.dumps(self.config))
        for mode in ("--check", "--apply"):
            with self.subTest(mode=mode):

                def orchestrate(config, state, *, apply, adapter, force=False):
                    self.assertEqual(apply, mode == "--apply")
                    self.assertEqual(adapter.psql, str(self.root / "psql"))
                    self.query(adapter)

                with patch.object(sys, "argv", ["deploy.py", "--config", str(config_path), mode]), patch.object(
                    self.deploy, "orchestrate", side_effect=orchestrate
                ), patch.object(self.deploy.shutil, "which", return_value="/synthetic/tool"), patch.object(
                    self.deploy, "select_psql", return_value=str(self.root / "psql")
                ):
                    self.deploy.main()
                self.assert_closed()

    def test_startup_timeout_cleans_up_owned_process(self):
        with patch.dict(os.environ, {"FAKE_TUNNEL": "stall"}):
            with self.assertRaisesRegex(ValueError, "did not become ready"):
                with self.adapter() as adapter:
                    adapter.connection.timeout = 0.2
                    self.query(adapter)
        self.assert_closed()

    def test_sql_failure_cleans_up_and_keeps_provider_details_private(self):
        with patch.dict(os.environ, {"FAKE_SQL_FAIL": "1"}):
            with self.assertRaises(subprocess.CalledProcessError) as failure:
                with self.adapter() as adapter:
                    self.query(adapter)
        self.assertEqual(failure.exception.cmd, ["psql"])
        self.assert_closed()

    def test_direct_connection_configuration_remains_supported(self):
        del self.config["operator_tunnel"]
        with self.adapter() as adapter:
            with patch.object(
                self.deploy.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "t")
            ) as run:
                self.query(adapter)
                self.assertIsNone(run.call_args.kwargs["env"])
        self.assertFalse(self.trace.exists())

    def test_main_sigterm_unwinds_tunnel(self):
        config_path = self.root / "deploy.json"
        config_path.write_text(json.dumps(self.config))

        def orchestrate(config, state, *, apply, adapter, force=False):
            self.query(adapter)
            os.kill(os.getpid(), signal.SIGTERM)

        previous = signal.getsignal(signal.SIGTERM)
        with patch.object(sys, "argv", ["deploy.py", "--config", str(config_path), "--check"]), patch.object(
            self.deploy, "orchestrate", side_effect=orchestrate
        ), patch.object(self.deploy.shutil, "which", return_value="/synthetic/tool"), patch.object(
            self.deploy, "select_psql", return_value=str(self.root / "psql")
        ):
            with self.assertRaises(SystemExit) as failure:
                self.deploy.main()
        self.assertEqual(failure.exception.code, 130)
        self.assertEqual(signal.getsignal(signal.SIGTERM), previous)
        self.assert_closed()

    def test_passfile_escapes_wildcards_and_comments_survive_retargeting(self):
        from operator_connection import retarget_passfile

        original = "# comment\n*:63115:example:observer:colon\\:password\n*:*:*:*:wildcard\nother:1234:*:*:other\n"
        self.assertEqual(retarget_passfile(original, 63115, 54321), original.replace(":63115:", ":54321:"))

    def test_sigterm_during_blocked_sql_reaps_sql_process(self):
        self.write_tool(
            "psql",
            "import os,time\nfrom pathlib import Path\nPath(os.environ['TRACE']+'.sql').write_text(str(os.getpid()))\ntime.sleep(60)\n",
        )
        config_path = self.root / "deploy.json"
        config_path.write_text(json.dumps(self.config))

        def orchestrate(config, state, *, apply, adapter, force=False):
            self.query(adapter)

        def interrupt():
            deadline = time.monotonic() + 3
            while not Path(str(self.trace) + ".sql").exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            os.kill(os.getpid(), signal.SIGTERM)

        worker = threading.Thread(target=interrupt)
        pid = None
        try:
            with patch.object(sys, "argv", ["deploy.py", "--config", str(config_path), "--check"]), patch.object(
                self.deploy, "orchestrate", side_effect=orchestrate
            ), patch.object(self.deploy.shutil, "which", return_value="/synthetic/tool"), patch.object(
                self.deploy, "select_psql", return_value=str(self.root / "psql")
            ):
                worker.start()
                with self.assertRaises(SystemExit):
                    self.deploy.main()
                worker.join(timeout=4)
            pid = int(Path(str(self.trace) + ".sql").read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            self.assert_closed()
        finally:
            if pid:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_lost_tunnel_does_not_block_provider_cleanup(self):
        with self.adapter() as adapter:
            self.query(adapter)
            os.kill(json.loads(self.trace.read_text())["pid"], signal.SIGTERM)
            adapter.connection.process.wait(timeout=2)
            self.assertEqual(
                adapter.call([sys.executable, "-c", 'print("cleanup ran")'], capture=True).strip(), "cleanup ran"
            )
            with self.assertRaisesRegex(ValueError, "tunnel"):
                self.query(adapter)
        self.assert_closed()

    def test_cleanup_reaches_descendant_listener(self):
        # IAP/SSH run as descendants of the gcloud process in production.
        self.write_tool(
            "gcloud",
            """
import json,os,signal,subprocess,sys,time
from pathlib import Path
args=sys.argv[1:];port=int(args[args.index('-L')+1].split(':')[1])
child=subprocess.Popen([sys.executable,'-c','import socket,time;s=socket.socket();s.bind(("127.0.0.1",'+str(port)+'));s.listen();time.sleep(60)'])
Path(os.environ['TRACE']).write_text(json.dumps(dict(pid=os.getpid(),args=args,port=port)))
def finish(*_):
 child.wait(timeout=3)
 sys.exit(0)
signal.signal(signal.SIGTERM,finish)
while True:time.sleep(1)
""",
        )
        with self.adapter() as adapter:
            self.query(adapter)
        self.assert_closed()

    def test_existing_private_config_can_use_adjacent_tunnel_setup(self):
        path = self.root / "deploy.json"
        config = dict(self.config)
        tunnel = config.pop("operator_tunnel")
        path.write_text(json.dumps(config))
        (self.root / "operator-tunnel.json").write_text(json.dumps(tunnel))
        self.assertEqual(self.deploy.read_config(path)["operator_tunnel"], tunnel)
        self.assertEqual(json.loads(path.read_text()), config)
