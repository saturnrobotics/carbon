#!/usr/bin/env python3
"""Provision and update a private Carbon VM. No cloud calls without --apply."""

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import private_postgres

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
DEPLOY_BRANCH = "saturn/main"
SECRET_KEYS = {"CLOUDFLARE_API_TOKEN", "TAILSCALE_AUTH_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY"}
CONFIG_KEYS = {"PROJECT_ID", "REGION", "ZONE", "VM_NAME", "MACHINE_TYPE", "DATA_DISK_GB", "DNS_ZONE_NAME", "ERP_HOST", "MES_HOST", "SUPABASE_HOST", "AUTH_ALLOWED_GOOGLE_DOMAIN", "ACME_EMAIL", "TAILSCALE_HOSTNAME", "SOURCE_REPO_URL"}


def run(args, *, capture=False, input=None):
    return subprocess.run(args, check=True, text=True, input=input,
                          stdout=subprocess.PIPE if capture else None).stdout


def private_json(path):
    path = path.expanduser().resolve()
    if path.stat().st_mode & 0o077:
        raise ValueError(f"Restrict private configuration permissions: chmod 600 {path}")
    # Even non-secret project/domain configuration must not enter the public fork.
    try:
        relative = path.relative_to(REPO)
    except ValueError:
        pass
    else:
        tracked = run(["git", "-C", str(REPO), "ls-files", "--", str(relative)], capture=True)
        ignored = subprocess.run(["git", "-C", str(REPO), "check-ignore", "-q", str(relative)]).returncode == 0
        if tracked or not ignored:
            raise ValueError("Configuration inside the checkout must be untracked and gitignored; use .local/.")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError("Configuration must be a JSON object")
    return value


def validate(config, secrets):
    if set(config) - CONFIG_KEYS - private_postgres.OPTIONAL_KEYS or set(secrets) - SECRET_KEYS:
        raise ValueError("Unknown configuration keys; see config.example.json and secrets.example.json")
    private_postgres.validate(config)
    for key in CONFIG_KEYS:
        if key not in config:
            raise ValueError(f"Missing {key}")
        if key != "DATA_DISK_GB" and not isinstance(config[key], str):
            raise ValueError(f"{key} must be a string")
    if any(not isinstance(value, str) for value in secrets.values()):
        raise ValueError("Secret values must be strings")
    for key in SECRET_KEYS - {"RESEND_API_KEY", "TAILSCALE_AUTH_KEY"}:
        if not isinstance(secrets.get(key), str) or not secrets[key] or secrets[key].startswith("replace-"):
            raise ValueError(f"Supply {key} in the private secrets file")
    for key, value in {**config, **secrets}.items():
        if isinstance(value, str) and (any(ord(c) < 32 for c in value) or "$" in value):
            raise ValueError(f"Control characters and dollar interpolation are not allowed in {key}")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", config["PROJECT_ID"]) or config["PROJECT_ID"] == "your-gcp-project":
        raise ValueError("Set PROJECT_ID to an existing billed GCP project ID")
    if not re.fullmatch(r"[a-z]+-[a-z]+[0-9]+", config["REGION"]):
        raise ValueError("Use a GCP region such as us-east1 (not us-east-1)")
    if not re.fullmatch(re.escape(config["REGION"]) + r"-[a-z]", config["ZONE"]):
        raise ValueError("ZONE must be in REGION")
    for key in ("VM_NAME", "TAILSCALE_HOSTNAME"):
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,24}[a-z0-9]", config[key]):
            raise ValueError(f"Invalid {key}; use 2–26 lowercase letters, digits or hyphens")
    if not re.fullmatch(r"[a-z][a-z0-9-]+", config["MACHINE_TYPE"]):
        raise ValueError("Invalid MACHINE_TYPE")
    if type(config["DATA_DISK_GB"]) is not int or config["DATA_DISK_GB"] < 100:
        raise ValueError("DATA_DISK_GB must be an integer of at least 100")
    domain_pattern = r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}"
    for key in ("DNS_ZONE_NAME", "ERP_HOST", "MES_HOST", "SUPABASE_HOST", "AUTH_ALLOWED_GOOGLE_DOMAIN"):
        if not re.fullmatch(domain_pattern, config[key]):
            raise ValueError(f"Invalid lower-case DNS hostname: {key}")
    hosts = [config[k] for k in ("ERP_HOST", "MES_HOST", "SUPABASE_HOST")]
    if len(set(hosts)) != 3 or any(not h.endswith("." + config["DNS_ZONE_NAME"]) for h in hosts):
        raise ValueError("Use three distinct hostnames within DNS_ZONE_NAME")
    if not re.fullmatch(r"[^\s@]+@" + domain_pattern, config["ACME_EMAIL"]):
        raise ValueError("Invalid ACME_EMAIL")
    if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", config["SOURCE_REPO_URL"]):
        raise ValueError("SOURCE_REPO_URL must identify the public GitHub fork without a trailing slash")
    return {**config, **secrets}


class Cloud:
    def __init__(self, config):
        self.c = config

    def call(self, *args, capture=False):
        return run(["gcloud", *args, "--project", self.c["PROJECT_ID"], "--quiet"], capture=capture)

    def get(self, *args):
        # List operations distinguish absence from permission/network errors. Never
        # interpret a failed describe as authorization to create a replacement.
        return json.loads(self.call(*args, "--format=json", capture=True))

    def ensure(self, kind, name, create, scope=()):
        existing = self.get("compute", *kind, "list", *scope, "--filter", f"name={name}")
        if not existing:
            self.call("compute", *kind, "create", name, *create)
        elif len(existing) != 1:
            raise ValueError(f"Ambiguous existing resource {name}")
        return bool(existing)

    def ssh(self, *args, capture=False):
        return self.call("compute", "ssh", self.c["VM_NAME"], "--zone", self.c["ZONE"],
                         "--tunnel-through-iap", "--command", shlex.join(args), capture=capture)

    def scp(self, source, dest):
        self.call("compute", "scp", str(source), f"{self.c['VM_NAME']}:{dest}",
                  "--zone", self.c["ZONE"], "--tunnel-through-iap")

    def provision(self):
        c, n, region, zone = self.c, self.c["VM_NAME"], self.c["REGION"], self.c["ZONE"]
        self.call("services", "enable", "compute.googleapis.com", "iap.googleapis.com")
        self.ensure(["networks"], n + "-vpc", ["--subnet-mode=custom"])
        self.ensure(["networks", "subnets"], n + "-subnet", ["--network", n + "-vpc", "--region", region, "--range=10.73.0.0/24", "--enable-private-ip-google-access"], ["--regions", region])
        self.ensure(["routers"], n + "-router", ["--network", n + "-vpc", "--region", region], ["--regions", region])
        nats = self.get("compute", "routers", "nats", "list", "--router", n + "-router", "--region", region)
        if not any(nat["name"] == n + "-nat" for nat in nats):
            self.call("compute", "routers", "nats", "create", n + "-nat", "--router", n + "-router", "--region", region, "--nat-all-subnet-ip-ranges", "--auto-allocate-nat-external-ips")
        self.ensure(["firewall-rules"], n + "-iap", ["--network", n + "-vpc", "--direction=INGRESS", "--priority=900", "--action=ALLOW", "--rules=tcp:22", "--source-ranges=35.235.240.0/20", "--target-tags", n])
        if c.get("POSTGRES_PRIVATE_IP"):
            self.ensure(["firewall-rules"], n + "-postgres", ["--network", n + "-vpc", "--direction=INGRESS", "--priority=900", "--action=ALLOW", "--rules=tcp:5432", "--source-ranges", ",".join(c["POSTGRES_CLIENT_CIDRS"]), "--target-tags", n])
        self.ensure(["firewall-rules"], n + "-deny-ingress", ["--network", n + "-vpc", "--direction=INGRESS", "--priority=1000", "--action=DENY", "--rules=all", "--source-ranges=0.0.0.0/0", "--target-tags", n])
        self.ensure(["disks"], n + "-data", ["--zone", zone, "--size", str(c["DATA_DISK_GB"]) + "GB", "--type=pd-balanced", "--labels=application=carbon"], ["--zones", zone])
        policies = self.get("compute", "resource-policies", "list", "--regions", region, "--filter", f"name={n}-daily")
        if not policies:
            self.call("compute", "resource-policies", "create", "snapshot-schedule", n + "-daily", "--region", region, "--daily-schedule", "--start-time=06:00", "--max-retention-days=14", "--on-source-disk-delete=keep-auto-snapshots", "--storage-location", region)
        disk = self.get("compute", "disks", "describe", n + "-data", "--zone", zone)
        if not any(p.endswith("/" + n + "-daily") for p in disk.get("resourcePolicies", [])):
            self.call("compute", "disks", "add-resource-policies", n + "-data", "--zone", zone, "--resource-policies", n + "-daily")
        private_address = ["--private-network-ip", c["POSTGRES_PRIVATE_IP"]] if c.get("POSTGRES_PRIVATE_IP") else []
        existed = self.ensure(["instances"], n, ["--zone", zone, "--machine-type", c["MACHINE_TYPE"], "--subnet", n + "-subnet", "--no-address", "--no-service-account", "--no-scopes", "--image-family=debian-12", "--image-project=debian-cloud", "--boot-disk-size=50GB", "--disk", f"name={n}-data,device-name=carbon-data,mode=rw,boot=no,auto-delete=no", "--tags", n, "--metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE", "--shielded-secure-boot", "--deletion-protection", *private_address], ["--zones", zone])
        self.check_firewall()
        self.check_vm()
        if c.get("POSTGRES_PRIVATE_IP"):
            self.reserve_postgres_address()
        return existed

    def reserve_postgres_address(self):
        c, n = self.c, self.c["VM_NAME"]
        self.ensure(["addresses"], n + "-postgres", ["--region", c["REGION"], "--subnet", n + "-subnet", "--addresses", c["POSTGRES_PRIVATE_IP"]], ["--regions", c["REGION"]])
        address = self.get("compute", "addresses", "describe", n + "-postgres", "--region", c["REGION"])
        if (address.get("addressType") != "INTERNAL" or address.get("address") != c["POSTGRES_PRIVATE_IP"]
                or not address.get("subnetwork", "").endswith("/" + n + "-subnet")
                or any(not user.endswith("/instances/" + n) for user in address.get("users", []))):
            raise ValueError("Reserved private PostgreSQL address has drifted; review it before deploying")

    def check_firewall(self):
        n = self.c["VM_NAME"]
        rules = self.get("compute", "firewall-rules", "list")
        rules = [r for r in rules if r.get("network", "").endswith("/" + n + "-vpc") and r.get("direction") == "INGRESS"]
        expected = {
            n + "-iap": (900, "allowed", [{"IPProtocol": "tcp", "ports": ["22"]}], ["35.235.240.0/20"]),
            n + "-deny-ingress": (1000, "denied", [{"IPProtocol": "all"}], ["0.0.0.0/0"]),
        }
        if self.c.get("POSTGRES_PRIVATE_IP"):
            expected[n + "-postgres"] = (900, "allowed", [{"IPProtocol": "tcp", "ports": ["5432"]}], self.c["POSTGRES_CLIENT_CIDRS"])
        for name, (priority, action, protocol, sources) in expected.items():
            rule = next((r for r in rules if r["name"] == name), {})
            if (rule.get("disabled", False) or rule.get("priority") != priority
                    or rule.get(action) != protocol or rule.get("sourceRanges") != sources
                    or rule.get("targetTags") != [n] or rule.get("sourceTags")
                    or rule.get("sourceServiceAccounts") or rule.get("targetServiceAccounts")):
                raise ValueError("Carbon firewall configuration has drifted; review it before deploying")
        if any(r.get("allowed") and not r.get("disabled", False) and r["name"] not in expected for r in rules):
            raise ValueError("Unexpected ingress allow rule in the dedicated Carbon network")

    def check_vm(self):
        vm = self.get("compute", "instances", "describe", self.c["VM_NAME"], "--zone", self.c["ZONE"])
        interfaces = vm.get("networkInterfaces", [])
        if len(interfaces) != 1 or interfaces[0].get("accessConfigs") or interfaces[0].get("ipv6AccessConfigs"):
            raise ValueError("VM must have one network interface and no external IPv4/IPv6 address")
        if not interfaces[0]["network"].endswith("/" + self.c["VM_NAME"] + "-vpc"):
            raise ValueError("Existing VM is not on the dedicated Carbon network")
        if self.c.get("POSTGRES_PRIVATE_IP") and interfaces[0].get("networkIP") != self.c["POSTGRES_PRIVATE_IP"]:
            raise ValueError("POSTGRES_PRIVATE_IP must match the existing VM's private network address")
        if not any(d.get("deviceName") == "carbon-data" and not d.get("autoDelete", True)
                   and d.get("source", "").endswith("/" + self.c["VM_NAME"] + "-data") for d in vm.get("disks", [])):
            raise ValueError("VM must have a retained carbon-data disk")
        return vm


class Cloudflare:
    def __init__(self, token):
        self.token = token

    def call(self, path, data=None, method=None):
        request = urllib.request.Request("https://api.cloudflare.com/client/v4/" + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.load(response)
        except urllib.error.HTTPError as exc:
            raise ValueError(f"Cloudflare request failed (HTTP {exc.code}); check zone-scoped token permissions") from None
        if not body.get("success"):
            raise ValueError("Cloudflare request failed; check DNS zone and token permissions")
        return body["result"]

    def zone(self, name):
        zones = self.call("zones?" + urllib.parse.urlencode({"name": name}))
        if len(zones) != 1:
            raise ValueError("Cloudflare token must see exactly one zone matching DNS_ZONE_NAME")
        return zones[0]["id"]

    def update(self, zone, host, address):
        records = self.call(f"zones/{zone}/dns_records?" + urllib.parse.urlencode({"name": host}))
        if any(r["type"] in ("AAAA", "CNAME") for r in records) or sum(r["type"] == "A" for r in records) > 1:
            raise ValueError("Conflicting A/AAAA/CNAME record; review existing DNS before deployment")
        current = next((r for r in records if r["type"] == "A"), None)
        if current and (current["content"] != address or current.get("proxied")):
            raise ValueError("Existing DNS points elsewhere or is proxied; review/remove it before deploying")
        if not current:
            self.call(f"zones/{zone}/dns_records", {"type": "A", "name": host, "content": address, "ttl": 300, "proxied": False}, "POST")


def revision():
    branch = run(["git", "-C", str(REPO), "branch", "--show-current"], capture=True).strip()
    if branch != DEPLOY_BRANCH:
        raise ValueError(f"Deployment uses {DEPLOY_BRANCH}; run git switch {DEPLOY_BRANCH} first")
    for operation in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
        path = run(["git", "-C", str(REPO), "rev-parse", "--git-path", operation], capture=True).strip()
        if (REPO / path).exists():
            raise ValueError("Finish or abort the current Git operation before deploying")
    if run(["git", "-C", str(REPO), "status", "--porcelain"], capture=True).strip():
        raise ValueError("Review and commit the source first; deployment uploads only a clean committed checkout")
    return run(["git", "-C", str(REPO), "rev-parse", "refs/heads/" + DEPLOY_BRANCH], capture=True).strip()


def publish_source(config, rev):
    slug = config["SOURCE_REPO_URL"].removeprefix("https://github.com/")
    allowed = {f"git@github.com:{slug}", f"https://github.com/{slug}", f"ssh://git@github.com/{slug}"}
    destinations = run(["git", "-C", str(REPO), "remote", "get-url", "--push", "--all", "origin"], capture=True).splitlines()
    if len(destinations) != 1 or destinations[0].removesuffix(".git") not in allowed:
        raise ValueError("origin must have one push URL matching SOURCE_REPO_URL; inspect git remote -v")
    print("Checking that the latest upstream/main is included...", flush=True)
    run(["git", "-C", str(REPO), "fetch", "--no-tags", "upstream", "refs/heads/main:refs/remotes/upstream/main"])
    contains = subprocess.run(["git", "-C", str(REPO), "merge-base", "--is-ancestor", "refs/remotes/upstream/main", rev])
    if contains.returncode != 0:
        raise ValueError("Merge the latest upstream first: bash contrib/deploying/gcp-tailscale/fork.sh sync; verify and rerun make deploy")
    print(f"Publishing {DEPLOY_BRANCH} at {rev[:12]}...", flush=True)
    # Pin the source we upload and publish to the same commit. No force push,
    # implicit feature-branch publication, local secrets, or GitHub build runner.
    run(["git", "-C", str(REPO), "push", "--no-follow-tags", "origin", f"{rev}:refs/heads/{DEPLOY_BRANCH}"])
    print("Verifying public access to the deployed source...", flush=True)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(config["SOURCE_REPO_URL"] + "/tree/" + rev, timeout=30) as response:
                if response.status != 200:
                    raise ValueError("GitHub source verification did not return HTTP 200")
            return
        except urllib.error.HTTPError as exc:
            exc.close()
            if exc.code == 404 and attempt < 4:
                time.sleep(2)
                continue
            raise ValueError(f"GitHub source verification failed (HTTP {exc.code}); confirm SOURCE_REPO_URL is public and contains the pushed commit, then retry") from None
        except (urllib.error.URLError, TimeoutError):
            raise ValueError("Could not reach GitHub to verify public source; check your connection and retry") from None


def deploy(config):
    rev = revision()
    publish_source(config, rev)
    config = {**config, "DEPLOY_REVISION": rev, "SOURCE_CODE_URL": config["SOURCE_REPO_URL"] + "/tree/" + rev}
    cf = Cloudflare(config["CLOUDFLARE_API_TOKEN"])
    print("Checking Cloudflare DNS access...", flush=True)
    cf_zone = cf.zone(config["DNS_ZONE_NAME"])
    cloud = Cloud(config)
    print("Provisioning the private GCP server...", flush=True)
    cloud.provision()
    for attempt in range(30):
        try:
            cloud.ssh("true", capture=True)
            break
        except subprocess.CalledProcessError:
            if attempt == 29:
                raise
            time.sleep(5)
    staging = cloud.ssh("mktemp", "-d", "/tmp/carbon-upload.XXXXXXXX", capture=True).strip()
    if not re.fullmatch(r"/tmp/carbon-upload\.[A-Za-z0-9]+", staging):
        raise ValueError("Unexpected remote staging path")
    # TemporaryDirectory is mode 0700. Source and secret configuration travel
    # separately; neither the Git archive nor Docker build context contains secrets.
    with tempfile.TemporaryDirectory(prefix="carbon-deploy-") as work:
        work = Path(work)
        private = work / "config.json"
        private.write_text(json.dumps(config))
        private.chmod(0o600)
        archive = work / "source.tar.gz"
        run(["git", "-C", str(REPO), "archive", "--format=tar.gz", "--output", str(archive), rev])
        try:
            cloud.scp(private, staging + "/config.json")
            cloud.scp(archive, staging + "/source.tar.gz")
            cloud.scp(HERE / "bootstrap.sh", staging + "/bootstrap.sh")
            cloud.ssh("sudo", "bash", staging + "/bootstrap.sh", staging, rev)
            address = cloud.ssh("sudo", "tailscale", "ip", "-4", capture=True).strip()
            if ipaddress.ip_address(address) not in ipaddress.ip_network("100.64.0.0/10"):
                raise ValueError("Tailscale did not return a tailnet IPv4 address")
            for key in ("ERP_HOST", "MES_HOST", "SUPABASE_HOST"):
                cf.update(cf_zone, config[key], address)
            release = "/var/lib/carbon/releases/" + rev
            script = release + "/contrib/deploying/gcp-tailscale/host-deploy.sh"
            cloud.ssh("sudo", "bash", release + "/contrib/deploying/gcp-tailscale/certificates.sh")
            cloud.ssh("sudo", "bash", script, "/var/lib/carbon/config.json", release, "prepare")
            cloud.ssh("sudo", "bash", script, "/var/lib/carbon/config.json", release, "quiesce")
            # Every rollout gets a consistent snapshot with Docker stopped. A failed
            # migration leaves the stack stopped for deliberate recovery, not an
            # automatic downgrade against a potentially changed schema.
            cloud.ssh("sudo", "systemctl", "stop", "docker.service", "docker.socket")
            try:
                cloud.ssh("sudo", "sync")
                snapshot = f"{config['VM_NAME']}-pre-{rev[:8]}-{int(time.time())}"
                cloud.call("compute", "snapshots", "create", snapshot, "--source-disk", config["VM_NAME"] + "-data", "--source-disk-zone", config["ZONE"], "--storage-location", config["REGION"], "--description", "Carbon stopped-service pre-deployment snapshot")
            finally:
                cloud.ssh("sudo", "systemctl", "start", "docker.service")
            print("Recovery snapshot created:", snapshot)
            cloud.ssh("sudo", "bash", script, "/var/lib/carbon/config.json", release, "apply")
            cloud.check_vm()
            cloud.check_firewall()
            cloud.ssh("sudo", "bash", script, "/var/lib/carbon/config.json", release, "check")
            print("Deployed commit", rev)
            print("From a Tailscale device:", "https://" + config["ERP_HOST"], "https://" + config["MES_HOST"])
        finally:
            cloud.ssh("rm", "-rf", "--", staging)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=HERE / ".local/config.json")
    parser.add_argument("--secrets", type=Path, default=HERE / ".local/secrets.json")
    parser.add_argument("--apply", action="store_true", help="create/update GCP resources and deploy the committed source")
    args = parser.parse_args()
    config = validate(private_json(args.config), private_json(args.secrets))
    if args.apply:
        deploy(config)
    else:
        print("Configuration valid. No cloud requests or changes made.")
        print("Apply creates a private VM, NAT, retained data disk and snapshot schedule; sets three DNS-only Tailscale A records; builds, snapshots, migrates and verifies the full stack.")
        print("Run make deploy from clean, reviewed saturn/main; it publishes that commit and deploys from this laptop.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        # Do not echo subprocess command arguments or provider response bodies:
        # they can contain credentials. Detailed service logs stay on the VM.
        message = str(exc) if isinstance(exc, ValueError) else type(exc).__name__ + ": deployment step failed; inspect private local/VM logs"
        print("Error:", message, file=sys.stderr)
        sys.exit(1)
