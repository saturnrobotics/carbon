#!/usr/bin/env bash
# Compatibility entry point for the deployment branch's upstream merge helper.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/../contrib/deploying/gcp-tailscale/fork.sh" sync "$@"
