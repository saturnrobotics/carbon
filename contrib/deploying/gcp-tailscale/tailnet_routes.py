#!/usr/bin/env python3
"""Accept tailnet subnet routes only for an explicit private allowlist.

The Carbon host reaches HQ at an address another tailnet node advertises as a
subnet route; the HQ login back channel will use the same route. Linux
Tailscale installs only accepted routes, and only with --accept-routes. It puts
them in routing table 52, which is consulted before the main table, so an
unexpected route could divert this host's own traffic into the tailnet.

`apply` (run by bootstrap.sh on every deployment) turns route acceptance on only
when TAILNET_ACCEPT_ROUTES lists networks, then refuses any accepted route outside
that list or overlapping a network this host reaches directly. `check` repeats the
verification every five minutes from carbon-tailnet-routes.timer whenever the
allowlist is set, and before each HQ push. Either one turns acceptance back off
before failing. An empty or absent list keeps --accept-routes=false.
"""

import ipaddress
import json
import subprocess
import sys
import time

CONFIG_KEYS = {"TAILNET_ACCEPT_ROUTES"}
# deploy.py provisions the VM in this subnet; Docker's default address pools
# and link-local metadata are also local to the host.
VM_SUBNET = "10.73.0.0/24"
LOCAL_NETWORKS = (VM_SUBNET, "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16")
TAILNET_NETWORKS = tuple(ipaddress.ip_network(n) for n in ("100.64.0.0/10", "fd7a:115c:a1e0::/48"))
ROUTE_TABLE = "52"
MAX_ROUTES = 8
WAIT_SECONDS = 15


def _networks(value):
    try:
        return ipaddress.ip_network(value, strict=True)
    except (TypeError, ValueError):
        raise ValueError("TAILNET_ACCEPT_ROUTES entries must be exact CIDR networks") from None


def validate(config):
    routes = config.get("TAILNET_ACCEPT_ROUTES", [])
    if not isinstance(routes, list) or len(routes) > MAX_ROUTES or not all(isinstance(r, str) for r in routes):
        raise ValueError(f"TAILNET_ACCEPT_ROUTES must be a list of at most {MAX_ROUTES} CIDR strings")
    networks = [_networks(route) for route in routes]
    protected = [ipaddress.ip_network(n) for n in LOCAL_NETWORKS]
    clients = config.get("POSTGRES_CLIENT_CIDRS", [])
    if isinstance(clients, list):
        protected += [ipaddress.ip_network(c, strict=False) for c in clients if isinstance(c, str)]
    for network in networks:
        if network.version == 4 and network.prefixlen < 24 or network.version == 6 and network.prefixlen < 64:
            raise ValueError("TAILNET_ACCEPT_ROUTES entries must be /24 (IPv6 /64) or narrower")
        if not network.is_private or network.is_loopback or network.is_link_local or network.is_multicast:
            raise ValueError("TAILNET_ACCEPT_ROUTES entries must be private unicast networks")
        if any(network.overlaps(t) for t in TAILNET_NETWORKS if t.version == network.version):
            raise ValueError("TAILNET_ACCEPT_ROUTES must not name tailnet device addresses")
        if any(network.overlaps(p) for p in protected if p.version == network.version):
            raise ValueError("TAILNET_ACCEPT_ROUTES must not overlap the VM subnet, Docker or private client networks")
    return networks


def run(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def routes(table, execute=run):
    """Unicast destinations in a routing table, for both address families."""
    found = []
    for family in ("-4", "-6"):
        for entry in json.loads(execute(["ip", "-j", family, "route", "show", "table", table]) or "[]"):
            destination = entry.get("dst")
            if entry.get("type", "unicast") != "unicast" or not destination or destination == "default":
                continue
            found.append(ipaddress.ip_network(destination, strict=False))
    return found


def unexpected(accepted, allowed, local):
    """Accepted subnet routes outside the allowlist or overlapping local routes."""
    problems = []
    for network in accepted:
        if any(network.subnet_of(t) for t in TAILNET_NETWORKS if t.version == network.version):
            continue
        inside = any(network.subnet_of(a) for a in allowed if a.version == network.version)
        overlaps = any(network.overlaps(n) for n in local if n.version == network.version)
        if not inside or overlaps:
            problems.append(network)
    return problems


def verify(allowed, execute=run):
    local = routes("main", execute) + [ipaddress.ip_network(n) for n in LOCAL_NETWORKS]
    accepted = routes(ROUTE_TABLE, execute)
    return unexpected(accepted, allowed, local), accepted


def _refuse(problems, execute):
    execute(["tailscale", "set", "--accept-routes=false"])
    raise ValueError(f"Refused {len(problems)} accepted tailnet route(s) outside TAILNET_ACCEPT_ROUTES or overlapping "
                     "local networks; route acceptance is off. Review the tailnet's approved subnet routes.")


def apply(config, execute=run, sleep=time.sleep):
    allowed = validate(config)
    if not allowed:
        execute(["tailscale", "set", "--accept-routes=false"])
        return "Tailnet subnet routes are not accepted."
    execute(["tailscale", "set", "--accept-routes=true"])
    try:
        for _ in range(WAIT_SECONDS):
            problems, accepted = verify(allowed, execute)
            if problems or all(any(a.subnet_of(n) for a in accepted if a.version == n.version) for n in allowed):
                break
            sleep(1)
    except (OSError, ValueError, subprocess.CalledProcessError):
        _refuse(["unreadable routing table"], execute)
    if problems:
        _refuse(problems, execute)
    missing = [n for n in allowed if not any(a.subnet_of(n) for a in accepted if a.version == n.version)]
    if missing:
        # Not fatal: the advertising node, its route approval or the grant may
        # still be pending. Consumers of the route fail on their own.
        return f"Accepting allowlisted tailnet routes; {len(missing)} not yet advertised to this host."
    return "Accepting only the allowlisted tailnet routes."


def check(config, execute=run):
    allowed = validate(config)
    try:
        problems, _ = verify(allowed, execute)
    except (OSError, ValueError, subprocess.CalledProcessError):
        problems = ["unreadable routing table"]
    if problems:
        _refuse(problems, execute)
    return "Accepted tailnet routes match TAILNET_ACCEPT_ROUTES."


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 2 or argv[0] not in ("apply", "check"):
        print("Usage: tailnet_routes.py apply|check CONFIG_JSON", file=sys.stderr)
        return 2
    try:
        with open(argv[1]) as stream:
            config = json.load(stream)
        if not isinstance(config, dict):
            raise ValueError("Private configuration must be a JSON object")
        print((apply if argv[0] == "apply" else check)(config))
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        message = str(error) if isinstance(error, ValueError) else type(error).__name__
        print("tailnet routes: " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
