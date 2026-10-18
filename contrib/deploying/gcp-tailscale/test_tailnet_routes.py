"""Tailnet route acceptance: allowlist validation and fail-closed enforcement, offline."""

import json
from pathlib import Path
import subprocess
import unittest

import tailnet_routes

HERE = Path(__file__).resolve().parent
ALLOWED = "10.20.0.10/32"

# Synthetic `ip -j` output shaped like a GCE host with Docker and Tailscale.
MAIN_V4 = [{"dst": "default", "gateway": "10.73.0.1", "dev": "ens4"}, {"dst": "10.73.0.1", "dev": "ens4"},
           {"dst": "172.17.0.0/16", "dev": "docker0"}, {"dst": "172.18.0.0/16", "dev": "br-carbon"}]
MAIN_V6 = [{"dst": "fe80::/64", "dev": "ens4"}]
TAILNET_V4 = [{"dst": "100.100.100.100", "dev": "tailscale0"}, {"dst": "100.64.0.0/10", "dev": "tailscale0"},
              {"type": "throw", "dst": "127.0.0.0/8"}]
TAILNET_V6 = [{"dst": "fd7a:115c:a1e0::/48", "dev": "tailscale0"}]


class Host:
    """Records tailscale preference changes and serves synthetic route tables."""

    def __init__(self, accepted_v4=(), *, fail_reads=False):
        self.accepted_v4 = list(accepted_v4)
        self.fail_reads = fail_reads
        self.accept_routes = None
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        if args[0] == "tailscale":
            self.accept_routes = args[-1] == "--accept-routes=true"
            return ""
        if self.fail_reads:
            raise subprocess.CalledProcessError(1, args)
        family, table = args[2], args[-1]
        if table == "main":
            return json.dumps(MAIN_V4 if family == "-4" else MAIN_V6)
        extra = [{"dst": dst, "dev": "tailscale0"} for dst in self.accepted_v4] if self.accept_routes else []
        return json.dumps(TAILNET_V4 + extra if family == "-4" else TAILNET_V6)


class ValidationTests(unittest.TestCase):
    def test_allowlist_accepts_narrow_private_networks(self):
        self.assertEqual(tailnet_routes.validate({}), [])
        self.assertEqual([str(n) for n in tailnet_routes.validate({"TAILNET_ACCEPT_ROUTES": [ALLOWED]})], [ALLOWED])

    def test_broad_public_local_or_malformed_entries_are_refused(self):
        for routes in ("10.20.0.10/32", ["10.0.0.0/8"], ["8.8.8.8/32"], ["10.73.0.0/24"], ["10.73.0.5/32"],
                       ["172.17.0.10/32"], ["192.168.1.0/24"], ["169.254.169.254/32"], ["100.100.100.100/32"],
                       ["10.20.0.10/24"], ["not-a-network"], [ALLOWED] * 9, [7]):
            with self.subTest(routes=routes), self.assertRaises(ValueError):
                tailnet_routes.validate({"TAILNET_ACCEPT_ROUTES": routes})
        with self.assertRaisesRegex(ValueError, "private client"):
            tailnet_routes.validate({"TAILNET_ACCEPT_ROUTES": ["10.81.0.4/32"], "POSTGRES_CLIENT_CIDRS": ["10.81.0.0/26"]})

    def test_vm_subnet_matches_the_provisioned_network(self):
        self.assertIn("--range=" + tailnet_routes.VM_SUBNET, (HERE / "deploy.py").read_text())


class EnforcementTests(unittest.TestCase):
    def test_no_allowlist_keeps_route_acceptance_off(self):
        host = Host(["10.20.0.10"])
        tailnet_routes.apply({}, host, sleep=lambda _: None)
        self.assertEqual(host.calls, [["tailscale", "set", "--accept-routes=false"]])
        self.assertFalse(host.accept_routes)

    def test_allowlisted_route_is_accepted(self):
        host = Host(["10.20.0.10"])
        message = tailnet_routes.apply({"TAILNET_ACCEPT_ROUTES": [ALLOWED]}, host, sleep=lambda _: None)
        self.assertTrue(host.accept_routes)
        self.assertIn("only the allowlisted", message)
        self.assertIn("match", tailnet_routes.check({"TAILNET_ACCEPT_ROUTES": [ALLOWED]}, host))

    def test_missing_route_is_reported_without_failing(self):
        host = Host([])
        message = tailnet_routes.apply({"TAILNET_ACCEPT_ROUTES": [ALLOWED]}, host, sleep=lambda _: None)
        self.assertTrue(host.accept_routes)
        self.assertIn("not yet advertised", message)

    def test_unexpected_or_overlapping_routes_turn_acceptance_back_off(self):
        for extra in (["10.0.0.0/8"], ["10.30.0.0/24"], ["10.73.0.0/24"], ["172.18.0.0/16"], ["0.0.0.0/1"]):
            with self.subTest(extra=extra):
                host = Host(["10.20.0.10", *extra])
                with self.assertRaisesRegex(ValueError, "route acceptance is off"):
                    tailnet_routes.apply({"TAILNET_ACCEPT_ROUTES": [ALLOWED]}, host, sleep=lambda _: None)
                self.assertFalse(host.accept_routes)

    def test_check_reverts_a_route_approved_after_deployment(self):
        host = Host(["10.20.0.10"])
        tailnet_routes.apply({"TAILNET_ACCEPT_ROUTES": [ALLOWED]}, host, sleep=lambda _: None)
        host.accepted_v4.append("10.0.0.0/8")
        with self.assertRaisesRegex(ValueError, "route acceptance is off"):
            tailnet_routes.check({"TAILNET_ACCEPT_ROUTES": [ALLOWED]}, host)
        self.assertFalse(host.accept_routes)

    def test_unreadable_routing_tables_fail_closed(self):
        host = Host(["10.20.0.10"], fail_reads=True)
        with self.assertRaisesRegex(ValueError, "route acceptance is off"):
            tailnet_routes.apply({"TAILNET_ACCEPT_ROUTES": [ALLOWED]}, host, sleep=lambda _: None)
        self.assertFalse(host.accept_routes)
        with self.assertRaisesRegex(ValueError, "route acceptance is off"):
            tailnet_routes.check({}, host)


if __name__ == "__main__":
    unittest.main()
