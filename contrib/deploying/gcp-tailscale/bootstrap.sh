#!/usr/bin/env bash
# Run over IAP SSH, never as instance metadata (configuration contains secrets).
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run bootstrap as root' >&2; exit 1; }
upload=${1:?private upload directory required}
revision=${2:?source commit required}
# deploy.py passes private-lb explicitly; the private configuration must agree.
mode=${3:-tailscale}
[[ $upload =~ ^/tmp/carbon-upload\.[A-Za-z0-9]+$ && $revision =~ ^[a-f0-9]{40}$ ]] || exit 1
[[ $mode == tailscale || $mode == private-lb ]] || exit 1
device=/dev/disk/by-id/google-carbon-data
[[ -b $device ]] || { echo 'Retained carbon-data disk is missing' >&2; exit 1; }

# This dedicated disk is the only device the script may initialize. Refuse any
# existing signature except ext4; never reformat a recognizable filesystem.
filesystem=$(blkid -s TYPE -o value "$device" || true)
if [[ -z $filesystem ]]; then
  # private-lb adopts a disk copied from an existing deployment, never a new one.
  [[ $mode == tailscale ]] || { echo 'Blank data disk; private-lb mode adopts a copied Carbon disk and never formats one' >&2; exit 1; }
  [[ -z $(wipefs --no-act --noheadings --output TYPE "$device") ]] || { echo 'Unexpected data disk signature; refusing to format' >&2; exit 1; }
  mkfs.ext4 -q -L carbon-data "$device"
elif [[ $filesystem != ext4 ]]; then
  echo 'Existing data disk is not ext4; refusing to modify it' >&2
  exit 1
fi
mkdir -p /var/lib/carbon
if ! mountpoint -q /var/lib/carbon; then
  [[ -z $(ls -A /var/lib/carbon) ]] || { echo 'Nonempty unmounted data directory; refusing to hide its files' >&2; exit 1; }
  mount "$device" /var/lib/carbon
fi
[[ $(findmnt -n -o UUID /var/lib/carbon) == "$(blkid -s UUID -o value "$device")" ]] || { echo 'Wrong filesystem mounted at /var/lib/carbon' >&2; exit 1; }
disk_uuid=$(blkid -s UUID -o value "$device")
if ! grep -q "UUID=$disk_uuid /var/lib/carbon " /etc/fstab; then
  printf 'UUID=%s /var/lib/carbon ext4 defaults 0 2\n' "$disk_uuid" >> /etc/fstab
fi
chmod 700 /var/lib/carbon
if [[ $mode == private-lb ]] && ! [[ -d /var/lib/carbon/docker && -d /var/lib/carbon/secrets ]]; then
  echo 'The data disk holds no Carbon deployment; private-lb mode adopts a copied disk only' >&2
  exit 1
fi

if [[ ! -f /etc/carbon-bootstrap-v1 ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y ca-certificates curl gnupg python3 python3-yaml certbot python3-certbot-dns-cloudflare dnsutils
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod 644 /etc/apt/keyrings/docker.asc
  printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n' > /etc/apt/sources.list.d/docker.list
  packages=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
  if [[ $mode == tailscale ]]; then
    curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /etc/apt/keyrings/tailscale.gpg
    chmod 644 /etc/apt/keyrings/tailscale.gpg
    printf 'deb [signed-by=/etc/apt/keyrings/tailscale.gpg] https://pkgs.tailscale.com/stable/debian bookworm main\n' > /etc/apt/sources.list.d/tailscale.list
    packages+=(tailscale)
  fi
  apt-get update -qq
  apt-get install -y "${packages[@]}"
fi

install -d -m 0700 /var/lib/carbon/releases /var/lib/carbon/secrets
install -m 0600 "$upload/config.json" /var/lib/carbon/config.incoming.json
python3 - <<'PY'
import json, os
from pathlib import Path
p = Path('/var/lib/carbon/config.incoming.json')
c = json.loads(p.read_text())
token = c.pop('CLOUDFLARE_API_TOKEN')
Path('/var/lib/carbon/secrets/cloudflare.ini').write_text('dns_cloudflare_api_token = ' + token + '\n')
key = c.pop('TAILSCALE_AUTH_KEY', '')
if key and not key.startswith('replace-'):
    Path('/var/lib/carbon/secrets/tailscale_auth_key').write_text(key)
p.write_text(json.dumps(c))
os.replace(p, '/var/lib/carbon/config.json')
PY
configured=$(python3 -c 'import json; print(json.load(open("/var/lib/carbon/config.json")).get("INGRESS_MODE", "tailscale"))')
[[ $configured == "$mode" ]] || { echo 'Bootstrap ingress mode differs from the private configuration' >&2; exit 1; }

if [[ $mode == private-lb ]]; then
  # No tailnet node. Destroy the identity copied with the disk so no second
  # node can ever claim it, and keep Tailscale off this host.
  if command -v tailscale >/dev/null || command -v tailscaled >/dev/null || [[ -e /var/lib/tailscale || -L /var/lib/tailscale ]]; then
    echo 'Tailscale is present on this host; private-lb mode runs no tailnet node' >&2
    exit 1
  fi
  rm -rf --one-file-system /var/lib/carbon/tailscale
  rm -f /var/lib/carbon/secrets/tailscale_auth_key
fi

# Tailscale mode only; this block is unchanged and deliberately left unindented.
if [[ $mode == tailscale ]]; then
# Persist node identity with the data disk so VM recovery preserves the tailnet
# address. Do not erase or overwrite an existing Tailscale identity.
if [[ ! -L /var/lib/tailscale ]]; then
  systemctl stop tailscaled.service
  if [[ -d /var/lib/carbon/tailscale ]]; then
    if [[ -f /var/lib/tailscale/tailscaled.state ]]; then
      echo 'Both restored and boot-disk Tailscale identities exist; resolve before continuing' >&2
      exit 1
    fi
    if [[ -d /var/lib/tailscale ]]; then
      rmdir /var/lib/tailscale || { echo 'Boot-disk Tailscale directory is nonempty; preserve and move it before recovery' >&2; exit 1; }
    fi
  elif [[ -d /var/lib/tailscale ]]; then
    mv /var/lib/tailscale /var/lib/carbon/tailscale
  else
    mkdir -m 700 /var/lib/carbon/tailscale
  fi
  ln -s /var/lib/carbon/tailscale /var/lib/tailscale
fi
mkdir -p /etc/systemd/system/tailscaled.service.d
cat > /etc/systemd/system/tailscaled.service.d/carbon.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/carbon
[Service]
# Bootstrap owns this directory and its persistent-disk symlink. systemd's
# packaged StateDirectory=tailscale refuses that symlink with status 238.
StateDirectory=
EOF
systemctl daemon-reload
systemctl enable --now tailscaled.service
if ! tailscale status --json | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("BackendState") == "Running" else 1)'; then
  [[ -s /var/lib/carbon/secrets/tailscale_auth_key ]] || { echo 'Supply a new preauthorized TAILSCALE_AUTH_KEY in private secrets configuration' >&2; exit 1; }
  hostname=$(python3 -c 'import json; print(json.load(open("/var/lib/carbon/config.json"))["TAILSCALE_HOSTNAME"])')
  tailscale up --auth-key=file:/var/lib/carbon/secrets/tailscale_auth_key --hostname="$hostname" --accept-dns=false --accept-routes=false --ssh=false --timeout=120s
fi
rm -f /var/lib/carbon/secrets/tailscale_auth_key
tailscale ip -4 | python3 -c '
import ipaddress,json,sys
p="/var/lib/carbon/config.json"
address=sys.stdin.read().strip()
assert ipaddress.ip_address(address) in ipaddress.ip_network("100.64.0.0/10")
c=json.load(open(p)); c["TAILSCALE_IP"]=address
with open(p,"w") as f: json.dump(c,f)
'
fi

# Docker must wait for the retained disk and Tailscale after a reboot. Its
# containers restart only after the private bind address exists.
mkdir -p /etc/docker /etc/systemd/system/docker.service.d
if [[ ! -f /etc/carbon-bootstrap-v1 ]] && [[ $(docker info --format '{{.DockerRootDir}}') != /var/lib/carbon/docker ]]; then
  [[ -z $(docker ps --all --quiet) && -z $(docker image ls --quiet) ]] || { echo 'Existing Docker state on the boot disk; migrate it deliberately before deploying' >&2; exit 1; }
fi
python3 - "$mode" <<'PY'
import json, sys
from pathlib import Path
p=Path('/etc/docker/daemon.json')
c=json.loads(p.read_text()) if p.exists() else {}
if c.get('data-root', '/var/lib/carbon/docker') != '/var/lib/carbon/docker':
    raise SystemExit('Existing Docker data-root differs; migrate it deliberately before deploying')
# Docker 29's containerd image store otherwise lives on the boot disk, outside
# data-root. Use classic overlay2 from first boot so snapshots include images.
features = c.setdefault('features', {})
if Path('/etc/carbon-bootstrap-v1').exists() and features.get('containerd-snapshotter', True):
    raise SystemExit('Existing Docker uses a different image store; migrate it deliberately before deploying')
features['containerd-snapshotter'] = False
if sys.argv[1] == 'private-lb':
    # Keep Docker networks outside every range of the shared VPC.
    pools = [{'base': '172.31.0.0/16', 'size': 24}]
    if Path('/etc/carbon-bootstrap-v1').exists() and c.get('default-address-pools', pools) != pools:
        raise SystemExit('Existing Docker address pools differ; migrate them deliberately before deploying')
    c['default-address-pools'] = pools
c.update({'data-root':'/var/lib/carbon/docker', 'log-driver':'local', 'log-opts':{'max-size':'10m','max-file':'3'}})
p.write_text(json.dumps(c))
PY
if [[ $mode == private-lb ]]; then
cat > /usr/local/sbin/carbon-wait-private-ip <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
address=$(python3 -c 'import ipaddress, json; print(ipaddress.IPv4Address(json.load(open("/var/lib/carbon/config.json"))["POSTGRES_PRIVATE_IP"]))')
for attempt in {1..60}; do
  if ip -4 -o address show scope global | grep -qF "inet $address/"; then exit 0; fi
  sleep 2
done
echo 'Private address unavailable; Docker startup refused' >&2
exit 1
EOF
chmod 755 /usr/local/sbin/carbon-wait-private-ip
cat > /etc/systemd/system/docker.service.d/carbon.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/carbon
[Service]
ExecStartPre=/usr/local/sbin/carbon-wait-private-ip
EOF
else
cat > /usr/local/sbin/carbon-wait-tailnet <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for attempt in {1..60}; do
  if tailscale ip -4 2>/dev/null | grep -q '^100\.'; then exit 0; fi
  sleep 2
done
echo 'Tailscale address unavailable; Docker startup refused' >&2
exit 1
EOF
chmod 755 /usr/local/sbin/carbon-wait-tailnet
cat > /etc/systemd/system/docker.service.d/carbon.conf <<'EOF'
[Unit]
RequiresMountsFor=/var/lib/carbon
Requires=tailscaled.service
After=tailscaled.service
[Service]
ExecStartPre=/usr/local/sbin/carbon-wait-tailnet
EOF
fi
systemctl daemon-reload
if [[ ! -f /etc/carbon-bootstrap-v1 ]]; then
  if [[ $mode == private-lb ]]; then
    # Docker first loads the copied disk here. A crash-consistent copy records
    # containers as running, and unless-stopped would start them all (jobs,
    # mail, payment sync). Record what `compose stop` records instead; adoption
    # then removes them, and nothing starts until a deployment does.
    python3 - <<'PY'
import json
from pathlib import Path
for path in Path('/var/lib/carbon/docker/containers').glob('*/config.v2.json'):
    container = json.loads(path.read_text())
    if not container.get('HasBeenManuallyStopped'):
        container['HasBeenManuallyStopped'] = True
        path.write_text(json.dumps(container))
PY
  fi
  systemctl restart docker.service
fi
systemctl enable docker.service
docker info --format '{{.DockerRootDir}}' | grep -qx /var/lib/carbon/docker
docker info --format '{{.Driver}}' | grep -qx overlay2

release=/var/lib/carbon/releases/$revision
if [[ ! -d $release ]]; then
  unpack=$(mktemp -d /var/lib/carbon/releases/.unpack.XXXXXXXX)
  trap 'rm -rf -- "$unpack"' EXIT
  tar -xzf "$upload/source.tar.gz" -C "$unpack"
  chmod 755 "$unpack"
  mv "$unpack" "$release"
  trap - EXIT
fi
# Commit mode bits are not assumed for inherited scripts mounted in containers.
chmod 755 "$release/contrib/deploying/simple-docker-caddy/bin/secrets-entrypoint.sh" "$release/contrib/deploying/simple-docker-caddy/postgres/"*.sh
install -m 0755 "$release/contrib/deploying/gcp-tailscale/certificates.sh" /usr/local/sbin/carbon-certificates
if [[ $mode == private-lb ]]; then
  # The owning platform's data plane (wal_g.py): the pinned WAL-G release,
  # refused unless its sha256 matches, the wrapper PostgreSQL runs it through,
  # and the daily base backup.
  tooling=$release/contrib/deploying/gcp-tailscale
  chmod 755 "$tooling/wal-g-glibc.sh"
  python3 "$tooling/wal_g.py" install
  install -m 0755 "$tooling/wal-g-backup.sh" /usr/local/sbin/carbon-wal-g-backup
  python3 "$tooling/wal_g.py" units /etc/systemd/system
  systemctl daemon-reload
  systemctl enable --now carbon-wal-g-backup.timer
  # Host metrics and logs for the owning platform's alerts, such as data disk
  # use, sent as the VM's service account. Google's signed repository, major
  # version 2, as Google's installer script configures it.
  if ! dpkg-query --show --showformat='${Status}' google-cloud-ops-agent 2>/dev/null | grep -qx 'install ok installed'; then
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg -o /etc/apt/keyrings/google-cloud-ops-agent.asc
    chmod 644 /etc/apt/keyrings/google-cloud-ops-agent.asc
    printf 'deb [signed-by=/etc/apt/keyrings/google-cloud-ops-agent.asc] https://packages.cloud.google.com/apt google-cloud-ops-agent-bookworm-2 main\n' > /etc/apt/sources.list.d/google-cloud-ops-agent.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y google-cloud-ops-agent
  fi
fi
touch /etc/carbon-bootstrap-v1
if [[ $mode == private-lb ]]; then
  echo 'VM ready; configuration retained on the private data disk; no tailnet identity.'
else
  echo 'VM ready; configuration and node identity retained on the private data disk.'
fi
