#!/usr/bin/env bash
set -euo pipefail
deploy_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
if python3 -c 'import yaml; assert yaml.__version__ == "6.0.2"' >/dev/null 2>&1; then
  exec python3 "$deploy_dir/deploy.py" "$@"
fi
# Keep installation isolated, serialized and private. Preserve the caller's stdin
# across the bootstrap heredoc as well as every original command-line argument.
exec python3 - "$deploy_dir" "$@" 3<&0 <<'PY'
import fcntl
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1])
tools = root / ".local/deploy-python"
python = tools / "venv/bin/python"
probe = 'import yaml; assert yaml.__version__ == "6.0.2"'
os.umask(0o077)


def usable():
    try:
        return subprocess.run([str(python), "-c", probe], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, check=False).returncode == 0
    except OSError:
        return False


try:
    for directory in (root / ".local", tools, tools / "venv"):
        if directory.is_symlink():
            raise ValueError("Refusing a symlinked deployment tool directory")
    tools.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(tools / "bootstrap.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not usable():
            print("Preparing isolated deployment Python tools...", file=sys.stderr)
            descriptor = os.open(tools / "bootstrap.log", os.O_CREAT | os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w") as log:
                subprocess.run([sys.executable, "-m", "venv", str(tools / "venv")],
                               stdout=log, stderr=log, check=True)
                subprocess.run([str(python), "-m", "pip", "install", "--require-virtualenv",
                                "--disable-pip-version-check", "--no-input", "PyYAML==6.0.2"],
                               stdout=log, stderr=log, check=True)
                if not usable():
                    raise ValueError("Installed deployment tools failed their import check")
except (OSError, ValueError, subprocess.CalledProcessError):
    print("Error: Unable to prepare deployment Python tools. Check Python venv/pip availability and registry access; installation details, when available, are in contrib/deploying/gcp-tailscale/.local/deploy-python/bootstrap.log.", file=sys.stderr)
    sys.exit(1)

os.dup2(3, 0)
os.close(3)
os.execv(str(python), [str(python), str(root / "deploy.py"), *sys.argv[2:]])
PY
