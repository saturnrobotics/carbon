#!/usr/bin/env python3
"""Verify a disk snapshot in a disposable, isolated VM; never restore in place."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from deploy import private_json  # noqa: E402


# This program runs on a fresh boot disk, not from the copied deployment. Its
# Docker daemon uses its default data root; the copied daemon is never started.
HOST_PROGRAM = r'''
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

os.umask(0o077)
root = Path('/mnt/carbon-backup')
container = 'carbon-restore-check'

def run(*args, timeout=900, output=True):
    result = subprocess.run(args, text=True, timeout=timeout,
        stdout=subprocess.PIPE if output else subprocess.DEVNULL,
        stderr=subprocess.PIPE)
    if result.returncode:
        # The caller saves this stream only in its private local log.
        print(result.stderr, flush=True)
        raise RuntimeError('An isolated restore host command failed')
    return result.stdout

def fingerprint(directory):
    count = size = 0
    digest = hashlib.sha256()
    for path in sorted(directory.rglob('*')):
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            continue
        if not stat.S_ISREG(mode):
            raise RuntimeError('Backup contains an unsupported storage file type')
        content = hashlib.sha256()
        with path.open('rb') as handle:
            while chunk := handle.read(1024 * 1024):
                content.update(chunk)
                size += len(chunk)
        digest.update(str(path.relative_to(directory)).encode() + b'\0')
        digest.update(content.digest())
        count += 1
    return {'files': count, 'bytes': size, 'sha256': digest.hexdigest()}

def sql(statement, database='postgres'):
    value = run('docker', 'exec', '-e', 'PGDATABASE=' + database, container,
        'psql', '-X', '-h', '/tmp', '-U', 'supabase_admin', '-v',
        'ON_ERROR_STOP=1', '-Atc', statement)
    return json.loads(value)

run('apt-get', 'update')
run('env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y',
    '--no-install-recommends', 'docker.io', 'ca-certificates')
run('systemctl', 'start', 'docker')
if run('docker', 'info', '--format', '{{.DockerRootDir}}').strip() != '/var/lib/docker':
    raise RuntimeError('Restore host must use a fresh Docker data directory')
if run('docker', 'ps', '-aq').strip():
    raise RuntimeError('Restore host already has containers')
device = '/dev/disk/by-id/google-backup-data'
if run('blkid', '-s', 'TYPE', '-o', 'value', device).strip() != 'ext4':
    raise RuntimeError('Unsupported snapshot filesystem')
root.mkdir(mode=0o700)
run('mount', '-o', 'rw,nosuid,nodev', device, str(root))

metadata = []
for path in (root / 'docker/containers').glob('*/config.v2.json'):
    value = json.loads(path.read_text())
    if value.get('Config', {}).get('Labels', {}).get('com.docker.compose.service') == 'postgres':
        metadata.append(value)
if len(metadata) != 1:
    raise RuntimeError('Snapshot must identify exactly one deployed PostgreSQL container')
image = metadata[0]['Config']['Image']
image_id = metadata[0].get('Image')
if not re.fullmatch(r'supabase/postgres:(?:[0-9][a-zA-Z0-9_.-]*)(?:@sha256:[a-f0-9]{64})?', image):
    raise RuntimeError('Snapshot PostgreSQL image must be an explicitly pinned Supabase image')
if not isinstance(image_id, str) or not re.fullmatch(r'sha256:[a-f0-9]{64}', image_id):
    raise RuntimeError('Snapshot does not identify the deployed PostgreSQL image content')
volumes = root / 'docker/volumes'
pgdata = volumes / 'carbon_pgdata/_data'
pgconfig = volumes / 'carbon_pgconfig/_data'
storage = volumes / 'carbon_storage/_data'
for directory in (pgdata, pgconfig, storage):
    if not directory.is_dir() or directory.resolve() != directory:
        raise RuntimeError('Required volume is absent or redirects outside the snapshot')
if not (pgdata / 'PG_VERSION').is_file():
    raise RuntimeError('Snapshot has no initialized PostgreSQL cluster')
if (pgdata / 'pg_wal').is_symlink() or any((pgdata / 'pg_tblspc').iterdir()):
    raise RuntimeError('External WAL or tablespaces require a dedicated restore procedure')
storage_before = fingerprint(storage)
configuration = fingerprint(pgconfig)
if not (pgconfig / 'pgsodium_root.key').is_file():
    raise RuntimeError('Snapshot is missing its database encryption root key')
if not (root / 'config.json').is_file() or not (root / 'secrets').is_dir():
    raise RuntimeError('Snapshot is missing deployment configuration or secrets')

# The source postmaster PID is stale in this independent copy. Retain WAL and all
# database files; PostgreSQL itself performs crash recovery on the copied cluster.
(pgdata / 'postmaster.pid').unlink(missing_ok=True)
work = Path('/run/carbon-restore-check')
work.mkdir(mode=0o755)
hba = work / 'pg_hba.conf'
hba.write_text('local all supabase_admin trust\nlocal all all reject\n')
hba.chmod(0o444)
run('docker', 'pull', image, timeout=1800)
if run('docker', 'image', 'inspect', '--format', '{{.Id}}', image).strip() != image_id:
    raise RuntimeError('Registry image differs from the image recorded in this snapshot')
args = ['docker', 'run', '-d', '--name', container, '--network=none',
    '--restart=no', '--user=postgres', '--entrypoint=postgres', '--shm-size=512m',
    '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--mount', 'type=bind,source=' + str(pgdata) + ',target=/var/lib/postgresql/data',
    '--mount', 'type=bind,source=' + str(pgconfig) + ',target=/etc/postgresql-custom',
    '--mount', 'type=bind,source=' + str(hba) + ',target=/run/restore-pg_hba.conf,readonly',
    image, '-c', 'config_file=/etc/postgresql/postgresql.conf',
    '-c', 'data_directory=/var/lib/postgresql/data',
    '-c', 'hba_file=/run/restore-pg_hba.conf',
    '-c', 'listen_addresses=', '-c', 'unix_socket_directories=/tmp',
    '-c', 'external_pid_file=/tmp/restore-postgresql.pid', '-c', 'logging_collector=off',
    '-c', 'ssl=off', '-c', 'cron.launch_active_jobs=off',
    '-c', 'archive_mode=off', '-c', 'archive_command=', '-c', 'restore_command=',
    '-c', 'default_transaction_read_only=on', '-c', 'autovacuum=off']
run(*args)
try:
    for attempt in range(180):
        status = subprocess.run(['docker', 'exec', container, 'pg_isready',
            '-h', '/tmp', '-U', 'supabase_admin', '-d', 'postgres'], stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=30)
        if status.returncode == 0:
            break
        if run('docker', 'inspect', '--format', '{{.State.Running}}', container).strip() != 'true':
            raise RuntimeError('Restored PostgreSQL exited before becoming ready')
        time.sleep(2)
    else:
        raise RuntimeError('Restored PostgreSQL did not become ready')
    host = json.loads(run('docker', 'inspect', container))[0]['HostConfig']
    if host['NetworkMode'] != 'none' or host.get('PortBindings'):
        raise RuntimeError('Restore container network isolation failed')
    settings = sql("SELECT json_build_object('recoveryComplete', NOT pg_is_in_recovery(), "
        "'fsync', current_setting('fsync'), 'fullPageWrites', current_setting('full_page_writes'), "
        "'listenAddresses', current_setting('listen_addresses'), "
        "'cronEnabled', current_setting('cron.launch_active_jobs'), "
        "'readOnly', current_setting('default_transaction_read_only'), "
        "'serverVersion', current_setting('server_version'))")
    if not (settings['recoveryComplete'] and settings['fsync'] == 'on'
            and settings['fullPageWrites'] == 'on' and settings['listenAddresses'] == ''
            and settings['cronEnabled'] == 'off' and settings['readOnly'] == 'on'):
        raise RuntimeError('Restored database recovery or isolation settings failed')
    schemas = sql("SELECT json_object_agg(nspname, relations) FROM ("
        "SELECT n.nspname, count(c.oid) AS relations FROM pg_namespace n "
        "LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relkind IN ('r','p','m') "
        "WHERE n.nspname IN ('public','auth','storage','kanban') GROUP BY n.nspname) s")
    expected = {'public', 'auth', 'storage'}
    private_config = json.loads((root / 'config.json').read_text())
    if private_config.get('POSTGRES_PRIVATE_IP'):
        expected.add('kanban')
    if not expected.issubset(schemas) or any(schemas[name] == 0 for name in expected):
        raise RuntimeError('Restored database is missing required application schemas')
    databases = sql("SELECT json_agg(datname ORDER BY datname) FROM pg_database "
        "WHERE NOT datistemplate AND datallowconn")
    for database in databases:
        # This is a discarded readability check, not a persisted logical backup.
        # /dev/null cannot be fsynced; ordinary backup exports must retain syncing.
        run('docker', 'exec', '-e', 'PGDATABASE=' + database, container, 'pg_dump',
            '-h', '/tmp', '-U', 'supabase_admin', '--format=custom', '--no-sync', '--file=/dev/null',
            timeout=3600, output=False)
    storage_rows = sql('SELECT to_json(count(*)) FROM storage.objects')
    storage_after = fingerprint(storage)
    if storage_before != storage_after:
        raise RuntimeError('Read-only storage verification changed restored files')
    receipt = {'recovery': settings, 'schemaRelations': schemas,
        'databasesFullyRead': len(databases), 'storageObjects': storage_rows,
        'storage': storage_after, 'databaseConfiguration': configuration,
        'networkIsolated': True, 'applicationContainersStarted': False}
    print('RESTORE_RECEIPT=' + json.dumps(receipt, sort_keys=True), flush=True)
finally:
    # Container logs can contain private details, so only the private local log
    # receives them. The caller never renders raw logs or record contents.
    logs = subprocess.run(['docker', 'logs', container], text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
    print('PRIVATE_POSTGRES_LOG_START\n' + logs + '\nPRIVATE_POSTGRES_LOG_END', flush=True)
    subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL)
'''


def validate(config, snapshot):
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", config.get("PROJECT_ID", "")):
        raise ValueError("Invalid PROJECT_ID")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", config.get("REGION", "")):
        raise ValueError("Invalid REGION")
    if not re.fullmatch(re.escape(config["REGION"]) + r"-[a-z]", config.get("ZONE", "")):
        raise ValueError("ZONE must be in REGION")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,24}[a-z0-9]", config.get("VM_NAME", "")):
        raise ValueError("Invalid VM_NAME")
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,61}[a-z0-9]", snapshot):
        raise ValueError("Invalid snapshot name")


def validate_snapshot(config, snapshot):
    expected = f"/projects/{config['PROJECT_ID']}/zones/{config['ZONE']}/disks/{config['VM_NAME']}-data"
    if snapshot.get("status") != "READY" or not snapshot.get("sourceDisk", "").endswith(expected):
        raise ValueError("Snapshot must be READY and belong to this deployment's data disk")


def private_write(path, value):
    with path.open("w") as handle:
        os.fchmod(handle.fileno(), 0o600)
        json.dump(value, handle, indent=2)
        handle.write("\n")


class RestoreCheck:
    def __init__(self, config, log):
        self.config = config
        self.log = log
        self.token = uuid.uuid4().hex[:12]
        self.vm = config["VM_NAME"] + "-restore-" + self.token
        self.disk = self.vm + "-data"
        self.labels = {"managed-by": "carbon-restore-check", "restore-run": self.token}

    def call(self, *args, input=None, timeout=1800, check=True):
        command = ["gcloud", *args, "--project", self.config["PROJECT_ID"], "--quiet"]
        result = subprocess.run(command, input=input, text=True, timeout=timeout,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.log.write(shlex.join(command) + "\n" + result.stdout + result.stderr + "\n")
        self.log.flush()
        if check and result.returncode:
            raise RuntimeError("Restore verification cloud command failed; inspect the private log")
        return result

    def get(self, *args):
        return json.loads(self.call(*args, "--format=json").stdout)

    def cleanup(self):
        """Delete only randomly named resources that still bear this run's labels."""
        zone = self.config["ZONE"]
        for kind, name in (("instances", self.vm), ("disks", self.disk)):
            existing = self.get("compute", kind, "list", "--zones", zone, "--filter", "name=" + name)
            if not existing:
                continue
            if len(existing) != 1 or any(existing[0].get("labels", {}).get(k) != v for k, v in self.labels.items()):
                raise RuntimeError("Restore cleanup refused a resource without this run's ownership labels")
            self.call("compute", kind, "delete", name, "--zone", zone)
        for kind, name in (("instances", self.vm), ("disks", self.disk)):
            if self.get("compute", kind, "list", "--zones", zone, "--filter", "name=" + name):
                raise RuntimeError("A temporary restore resource remains; inspect the private receipt")

    def execute(self, snapshot):
        c = self.config
        value = self.get("compute", "snapshots", "describe", snapshot)
        validate_snapshot(c, value)
        labels = ",".join(k + "=" + v for k, v in self.labels.items())
        self.call("compute", "disks", "create", self.disk, "--zone", c["ZONE"],
            "--source-snapshot", snapshot, "--type=pd-balanced", "--labels", labels)
        self.call("compute", "instances", "create", self.vm, "--zone", c["ZONE"],
            "--machine-type=e2-standard-2", "--subnet", c["VM_NAME"] + "-subnet",
            "--no-address", "--no-service-account", "--no-scopes",
            "--image-family=debian-12", "--image-project=debian-cloud", "--boot-disk-size=50GB",
            "--disk", f"name={self.disk},device-name=backup-data,mode=rw,boot=no,auto-delete=yes",
            "--tags", c["VM_NAME"], "--labels", labels, "--shielded-secure-boot",
            "--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE")
        vm = self.get("compute", "instances", "describe", self.vm, "--zone", c["ZONE"])
        interfaces = vm.get("networkInterfaces", [])
        if (vm.get("serviceAccounts") or len(interfaces) != 1
                or interfaces[0].get("accessConfigs") or interfaces[0].get("ipv6AccessConfigs")
                or not interfaces[0]["subnetwork"].endswith("/" + c["VM_NAME"] + "-subnet")
                or any(d.get("source", "").endswith("/" + c["VM_NAME"] + "-data") for d in vm["disks"])):
            raise RuntimeError("Temporary restore VM isolation validation failed")
        for attempt in range(30):
            ready = self.call("compute", "ssh", self.vm, "--zone", c["ZONE"],
                "--tunnel-through-iap", "--command", "true", timeout=60, check=False)
            if ready.returncode == 0:
                break
            time.sleep(10)
        else:
            raise RuntimeError("Temporary restore VM did not become reachable over IAP")
        result = self.call("compute", "ssh", self.vm, "--zone", c["ZONE"],
            "--tunnel-through-iap", "--command", "sudo python3 -", input=HOST_PROGRAM, timeout=7200)
        receipts = [line.removeprefix("RESTORE_RECEIPT=") for line in result.stdout.splitlines()
                    if line.startswith("RESTORE_RECEIPT=")]
        if len(receipts) != 1:
            raise RuntimeError("Restore verification returned no unambiguous success receipt")
        return {"snapshot": snapshot, "snapshotType": value.get("snapshotType"),
                "snapshotTime": value.get("creationTimestamp"), "checks": json.loads(receipts[0])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=HERE.parent / ".local/config.json")
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--apply", action="store_true", help="Create, verify, and delete temporary cloud resources")
    args = parser.parse_args()
    config = private_json(args.config)
    validate(config, args.snapshot)
    if not args.apply:
        print("Validated. With --apply: copy the selected snapshot to a temporary disk, verify PostgreSQL and storage in an isolated VM, then delete both temporary resources. The source deployment and snapshot are never modified.")
        return
    os.umask(0o077)
    directory = HERE.parent / ".local/restore-checks"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    started = dt.datetime.now(dt.timezone.utc)
    timer = time.monotonic()
    stamp = started.strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    with (directory / (stamp + ".log")).open("x") as log:
        os.fchmod(log.fileno(), 0o600)
        check = RestoreCheck(config, log)
        receipt = {"startedAt": started.isoformat(), "temporaryVm": check.vm, "temporaryDisk": check.disk,
                   "snapshot": args.snapshot, "verified": False, "cleanupComplete": False}
        try:
            receipt.update(check.execute(args.snapshot))
            receipt["verified"] = True
        finally:
            try:
                check.cleanup()
                receipt["cleanupComplete"] = True
            finally:
                receipt["finishedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
                receipt["elapsedSeconds"] = round(time.monotonic() - timer, 1)
                private_write(directory / (stamp + ".json"), receipt)
    print("Snapshot restore verified: PostgreSQL recovered, complete database dumps were readable, storage files were hashed, and temporary resources were deleted. Private receipt: " + str(directory / (stamp + ".json")))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(f"Error: {type(error).__name__}: restore verification failed; inspect private restore-check logs and receipts", file=sys.stderr)
        sys.exit(1)
