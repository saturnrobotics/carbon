#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || exit 1
mapfile -t values < <(python3 -c 'import json; c=json.load(open("/var/lib/carbon/config.json")); print("\n".join(c[k] for k in ["ACME_EMAIL","ERP_HOST","MES_HOST","SUPABASE_HOST"]))')
certbot certonly --non-interactive --agree-tos --email "${values[0]}" \
  --dns-cloudflare --dns-cloudflare-credentials /var/lib/carbon/secrets/cloudflare.ini \
  --dns-cloudflare-propagation-seconds 60 \
  --config-dir /var/lib/carbon/tls --work-dir /var/lib/carbon/acme-work \
  --logs-dir /var/lib/carbon/acme-logs --cert-name carbon --keep-until-expiring \
  -d "${values[1]}" -d "${values[2]}" -d "${values[3]}"

# Certbot's packaged timer uses a different config-dir. Install a separate timer
# with the same explicit private paths. Reload only after a successful renewal.
cat > /etc/systemd/system/carbon-certificates.service <<'EOF'
[Unit]
Description=Renew Carbon private-host HTTPS certificates using DNS validation
After=network-online.target docker.service
RequiresMountsFor=/var/lib/carbon
[Service]
Type=oneshot
UMask=0077
ExecStart=/usr/local/sbin/carbon-certificates
EOF
cat > /etc/systemd/system/carbon-certificates.timer <<'EOF'
[Unit]
Description=Check Carbon certificate renewal twice daily
[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now carbon-certificates.timer
if [[ -f /var/lib/carbon/runtime/compose.json ]] && docker compose -p carbon -f /var/lib/carbon/runtime/compose.json ps --status running -q caddy | grep -q .; then
  docker compose -p carbon -f /var/lib/carbon/runtime/compose.json exec -T caddy caddy reload --force --config /etc/caddy/Caddyfile
fi
