#!/usr/bin/env bash
# Run over IAP SSH, never as instance metadata (configuration contains secrets).
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Run bootstrap as root' >&2; exit 1; }
upload=${1:?private upload directory required}
revision=${2:?source commit required}
[[ $upload =~ ^/tmp/carbon-upload\.[A-Za-z0-9]+$ && $revision =~ ^[a-f0-9]{40}$ ]] || exit 1
device=/dev/disk/by-id/google-carbon-data
[[ -b $device ]] || { echo 'Retained carbon-data disk is missing' >&2; exit 1; }

# This dedicated disk is the only device the script may initialize. Refuse any
# existing signature except ext4; never reformat a recognizable filesystem.
filesystem=$(blkid -s TYPE -o value "$device" || true)
if [[ -z $filesystem ]]; then
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

if [[ ! -f /etc/carbon-bootstrap-v1 ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y ca-certificates curl gnupg python3 python3-yaml certbot python3-certbot-dns-cloudflare dnsutils
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod 644 /etc/apt/keyrings/docker.asc
  printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable\n' > /etc/apt/sources.list.d/docker.list
  curl -fsSL https://pkgs.tailscale.com/stable/debian/bookworm.noarmor.gpg -o /etc/apt/keyrings/tailscale.gpg
  chmod 644 /etc/apt/keyrings/tailscale.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/tailscale.gpg] https://pkgs.tailscale.com/stable/debian bookworm main\n' > /etc/apt/sources.list.d/tailscale.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin tailscale
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

# Docker must wait for the retained disk and Tailscale after a reboot. Its
# containers restart only after the private bind address exists.
mkdir -p /etc/docker /etc/systemd/system/docker.service.d
if [[ ! -f /etc/carbon-bootstrap-v1 ]] && [[ $(docker info --format '{{.DockerRootDir}}') != /var/lib/carbon/docker ]]; then
  [[ -z $(docker ps --all --quiet) && -z $(docker image ls --quiet) ]] || { echo 'Existing Docker state on the boot disk; migrate it deliberately before deploying' >&2; exit 1; }
fi
python3 - <<'PY'
import json
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
c.update({'data-root':'/var/lib/carbon/docker', 'log-driver':'local', 'log-opts':{'max-size':'10m','max-file':'3'}})
p.write_text(json.dumps(c))
PY
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
systemctl daemon-reload
if [[ ! -f /etc/carbon-bootstrap-v1 ]]; then
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
touch /etc/carbon-bootstrap-v1
echo 'VM ready; configuration and node identity retained on the private data disk.'
