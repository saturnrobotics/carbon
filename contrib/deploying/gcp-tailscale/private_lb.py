"""Optional private-load-balancer ingress on a network another deployment owns.

INGRESS_MODE selects how users reach Caddy. ``tailscale`` (the default, also
when the key is absent) keeps the dedicated network, the tailnet node and the
Cloudflare A records. ``private-lb`` serves Caddy on the VM's one private
address as the backend of an internal load balancer. In that mode this tooling
creates only the instance and its snapshot schedule. The network, subnet,
reserved address, service account, data disk, firewall rules and DNS records
must already exist; they are verified, never created or changed.
"""

import ipaddress
import re

import private_postgres

MODES = ("tailscale", "private-lb")
CONFIG_KEYS = {"INGRESS_MODE", "NETWORK", "SUBNET", "SERVICE_ACCOUNT", "INGRESS_ALLOWLIST"}
REQUIRED_KEYS = {"NETWORK", "SUBNET", "SERVICE_ACCOUNT", "INGRESS_ALLOWLIST", "POSTGRES_PRIVATE_IP"}
TAILSCALE_KEYS = {"TAILSCALE_HOSTNAME", "TAILSCALE_AUTH_KEY", "TAILSCALE_IP"}
RULE_KEYS = {"name", "priority", "ports", "sources", "target"}
SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]
RESOURCE_NAME = r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?"
ACCOUNT_ID = r"[a-z][a-z0-9-]{4,28}[a-z0-9]"
PROJECT = r"[a-z][a-z0-9-]{4,28}[a-z0-9]"


def mode(config):
    value = config.get("INGRESS_MODE", "tailscale")
    if value not in MODES:
        raise ValueError("INGRESS_MODE must be tailscale or private-lb")
    return value


def enabled(config):
    return mode(config) == "private-lb"


def required_keys(base_keys, config):
    """The base keys this mode requires; validate() checks its own REQUIRED_KEYS."""
    return set(base_keys) - {"TAILSCALE_HOSTNAME"} if enabled(config) else set(base_keys)


def bootstrap_args(config):
    """Extra bootstrap.sh arguments; tailscale mode keeps today's invocation."""
    return ("private-lb",) if enabled(config) else ()


def validate(config, secrets=()):
    """Check the mode's keys; return the canonical allowlist (empty in tailscale mode)."""
    if not enabled(config):
        if (CONFIG_KEYS - {"INGRESS_MODE"}) & set(config):
            raise ValueError("NETWORK, SUBNET, SERVICE_ACCOUNT and INGRESS_ALLOWLIST apply only to INGRESS_MODE=private-lb")
        return []
    present = set(config) | set(secrets)
    if present & TAILSCALE_KEYS:
        raise ValueError("INGRESS_MODE=private-lb runs no Tailscale node; remove the TAILSCALE_* settings")
    if any(key.startswith("PORTAL_") for key in present):
        raise ValueError("INGRESS_MODE=private-lb does not configure the Portal receiver; remove the PORTAL_* settings")
    for key in sorted(REQUIRED_KEYS):
        if key not in config:
            raise ValueError(f"Missing {key}, required by INGRESS_MODE=private-lb")
    for key in ("NETWORK", "SUBNET"):
        if not isinstance(config[key], str) or not re.fullmatch(RESOURCE_NAME, config[key]):
            raise ValueError(f"Invalid {key}; name the existing resource")
    project = config.get("PROJECT_ID", "")
    if not isinstance(project, str) or not re.fullmatch(
            ACCOUNT_ID + "@" + re.escape(project) + r"\.iam\.gserviceaccount\.com", str(config["SERVICE_ACCOUNT"])):
        raise ValueError("SERVICE_ACCOUNT must be the email of a service account in PROJECT_ID")
    return allowlist(config)


def allowlist(config):
    """Canonical INGRESS_ALLOWLIST: every ingress rule the network may enable."""
    rules = config["INGRESS_ALLOWLIST"]
    if not isinstance(rules, list) or not 1 <= len(rules) <= 32:
        raise ValueError("INGRESS_ALLOWLIST must list 1–32 ingress rules")
    canonical, names = [], set()
    for rule in rules:
        if not isinstance(rule, dict) or set(rule) != RULE_KEYS:
            raise ValueError("Each INGRESS_ALLOWLIST rule needs exactly name, priority, ports, sources and target")
        name, priority, ports, sources, target = (rule[key] for key in ("name", "priority", "ports", "sources", "target"))
        if not isinstance(name, str) or not re.fullmatch(RESOURCE_NAME, name) or name in names:
            raise ValueError("INGRESS_ALLOWLIST rule names must be distinct firewall rule names")
        names.add(name)
        if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 65535:
            raise ValueError(f"INGRESS_ALLOWLIST rule {name} needs an integer priority from 0 to 65535")
        if (not isinstance(ports, list) or not ports or len(set(map(str, ports))) != len(ports)
                or any(not isinstance(port, str) or not re.fullmatch(r"(?:tcp|udp):[1-9][0-9]{0,4}", port)
                       or int(port.split(":")[1]) > 65535 for port in ports)):
            raise ValueError(f"INGRESS_ALLOWLIST rule {name} ports must be distinct tcp:<port> or udp:<port> entries")
        if not isinstance(sources, list) or not 1 <= len(sources) <= 16 or len(set(map(str, sources))) != len(sources):
            raise ValueError(f"INGRESS_ALLOWLIST rule {name} must list 1–16 distinct source ranges")
        for source in sources:
            try:
                network = ipaddress.IPv4Network(source, strict=True) if isinstance(source, str) else None
            except ValueError:
                network = None
            if network is None or str(network) != source or network.prefixlen < 16:
                raise ValueError(f"INGRESS_ALLOWLIST rule {name} sources must be canonical IPv4 ranges of /16 or narrower")
        if not isinstance(target, str) or not re.fullmatch(ACCOUNT_ID + "@" + PROJECT + r"\.iam\.gserviceaccount\.com", target):
            raise ValueError(f"INGRESS_ALLOWLIST rule {name} must target a service account email, never tags")
        canonical.append({"name": name, "priority": priority, "ports": sorted(ports), "sources": sorted(sources), "target": target})
    own = [rule for rule in canonical if rule["target"] == config["SERVICE_ACCOUNT"]]
    database = sorted({source for rule in own if "tcp:5432" in rule["ports"] for source in rule["sources"]})
    settings = private_postgres.validate(config)
    if settings is None or database != sorted(settings[1]):
        # Supabase's own pg_hba.conf admits other sources with plaintext
        # passwords; the firewall must admit exactly the TLS-only client ranges.
        raise ValueError("INGRESS_ALLOWLIST must admit tcp:5432 to SERVICE_ACCOUNT from exactly POSTGRES_CLIENT_CIDRS")
    if not trusted_proxies(canonical, config["SERVICE_ACCOUNT"]):
        raise ValueError("INGRESS_ALLOWLIST must admit tcp:443 to SERVICE_ACCOUNT from the load balancer's private proxy-only subnet")
    return canonical


def trusted_proxies(rules, account):
    """Private sources admitted to Caddy: the load balancer's proxy-only subnet.

    Public health-check ranges are admitted to TCP 443 too, but never trusted
    for X-Forwarded-For.
    """
    return sorted({source for rule in rules if rule["target"] == account and "tcp:443" in rule["ports"]
                   for source in rule["sources"]
                   if any(ipaddress.IPv4Network(source).subnet_of(parent) for parent in private_postgres.PRIVATE_NETWORKS)})


def firewall_drift(rules, config):
    """Return why the network's ingress rules differ from the allowlist, or None."""
    expected = allowlist(config)
    suffix = "/networks/" + config["NETWORK"]
    ingress = [rule for rule in rules if rule.get("network", "").endswith(suffix) and rule.get("direction") == "INGRESS"]
    actual = {rule.get("name"): rule for rule in ingress}
    for want in expected:
        rule = actual.get(want["name"])
        if rule is None:
            return f"Ingress rule {want['name']} in INGRESS_ALLOWLIST is missing from NETWORK"
        ports = sorted(f"{entry.get('IPProtocol')}:{port}" for entry in rule.get("allowed", [])
                       for port in entry.get("ports") or ["all"])
        if (rule.get("disabled", False) or rule.get("priority") != want["priority"] or rule.get("denied")
                or ports != want["ports"] or sorted(rule.get("sourceRanges", [])) != want["sources"]
                or rule.get("targetServiceAccounts") != [want["target"]] or rule.get("targetTags")
                or rule.get("sourceTags") or rule.get("sourceServiceAccounts") or rule.get("destinationRanges")):
            return f"Ingress rule {want['name']} differs from INGRESS_ALLOWLIST"
    names = {want["name"] for want in expected}
    for rule in ingress:
        if rule.get("name") not in names and not rule.get("disabled", False):
            return f"Unexpected enabled ingress rule {rule.get('name')} on NETWORK"
    return None


def vm_drift(vm, config):
    """Return why the instance differs from the private-lb contract, or None."""
    interfaces = vm.get("networkInterfaces", [])
    if len(interfaces) != 1 or interfaces[0].get("accessConfigs") or interfaces[0].get("ipv6AccessConfigs"):
        return "VM must have one network interface and no external IPv4/IPv6 address"
    nic = interfaces[0]
    if (not nic.get("network", "").endswith("/networks/" + config["NETWORK"])
            or not nic.get("subnetwork", "").endswith("/subnetworks/" + config["SUBNET"])):
        return "Existing VM is not on NETWORK and SUBNET"
    if nic.get("networkIP") != config["POSTGRES_PRIVATE_IP"]:
        return "POSTGRES_PRIVATE_IP must match the existing VM's private network address"
    if [(account.get("email"), account.get("scopes")) for account in vm.get("serviceAccounts", [])] != [(config["SERVICE_ACCOUNT"], SCOPES)]:
        return "VM must run as SERVICE_ACCOUNT with the cloud-platform scope only"
    return None


def check_unmanaged(config, *, backups=False):
    """Refuse features that would create resources outside the shared platform."""
    if not enabled(config):
        return
    if backups:
        raise ValueError("INGRESS_MODE=private-lb does not provision managed cold backups; remove backups.json")
    if config.get("INVOICE_INTAKE_ENABLED") == "true":
        raise ValueError("INGRESS_MODE=private-lb keeps invoice intake off: it would create its own service account and role")


def caddyfile(config, sites):
    """Caddy on the private address, behind the load balancer and its health check.

    The load balancer and its health check may connect without SNI, so the ERP
    certificate name is the default. /healthz is answered by Caddy itself on
    every host, so one app's failure cannot take its siblings' hosts down.
    """
    proxies = " ".join(trusted_proxies(allowlist(config), config["SERVICE_ACCOUNT"]))
    blocks = [f"{{\n  auto_https off\n  default_sni {config['ERP_HOST']}\n  servers {{\n"
              f"    protocols h1 h2\n    trusted_proxies static {proxies}\n  }}\n}}\n"]
    for key, upstream in sites:
        blocks.append(f"https://{config[key]} {{\n  tls /tls/live/carbon/fullchain.pem /tls/live/carbon/privkey.pem\n"
                      f"  respond /healthz 200\n  reverse_proxy {upstream}\n}}\n")
    return "\n".join(blocks)
