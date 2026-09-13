"""Static foundation contracts that complement terraform validate offline.

Assertions run over a small HCL block parser rather than substrings, so a grant,
binding or output has to exist as the declared resource with the declared
arguments, not merely as text somewhere in a comment.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import importlib.util
import json
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("portal_release", HERE / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
IAP_SERVICE_AGENT = 'serviceAccount:service-${data.google_project.current.number}@gcp-sa-iap.iam.gserviceaccount.com'
RUNTIME_MEMBER = re.compile(r'google_service_account\.runtime\["([a-z]+)"\]')
EXACT_RESOURCE = re.compile(r"^resource\.name == 'projects/\$\{var\.project_id\}/locations/\$\{var\.region\}/(services|jobs)/([^'/]+)'$")
EDGE = re.compile(r'"([a-z-]+)"\s*=\s*\{\s*caller\s*=\s*"([a-z]+)"\s*,\s*receiver\s*=\s*"([a-z-]+)"\s*\}')
ACCESS = re.compile(r"(\w+)\s*=\s*\[([^\]]*)\]")


@dataclass
class Block:
    kind: str
    labels: tuple[str, ...]
    raw: str
    attrs: dict[str, str] = field(default_factory=dict)
    blocks: list[Block] = field(default_factory=list)

    def child(self, kind: str) -> Block | None:
        return next((block for block in self.blocks if block.kind == kind), None)

    def children(self, kind: str) -> list[Block]:
        return [block for block in self.blocks if block.kind == kind]


def skip_string(text: str, index: int) -> int:
    """Return the index after the quoted string starting at index, including ${} nesting."""
    index += 1
    depth = 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if depth == 0:
            if char == '"':
                return index + 1
            if text.startswith("${", index):
                depth = 1
                index += 2
                continue
        else:
            if char == '"':
                index = skip_string(text, index)
                continue
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
        index += 1
    raise ValueError("unterminated string")


def strip_comments(text: str) -> str:
    output, index = [], 0
    while index < len(text):
        char = text[index]
        if char == '"':
            end = skip_string(text, index)
            output.append(text[index:end])
            index = end
        elif char == "#" or text.startswith("//", index):
            end = text.find("\n", index)
            index = len(text) if end == -1 else end
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            index = len(text) if end == -1 else end + 2
        else:
            output.append(char)
            index += 1
    return "".join(output)


def matching_brace(text: str, index: int) -> int:
    depth = 0
    while index < len(text):
        char = text[index]
        if char == '"':
            index = skip_string(text, index)
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise ValueError("unbalanced block")


def read_value(text: str, index: int) -> tuple[str, int]:
    start, depth = index, 0
    while index < len(text):
        char = text[index]
        if char == '"':
            index = skip_string(text, index)
            continue
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        elif char == "\n" and depth == 0:
            break
        index += 1
    return text[start:index].strip(), index


def parse_body(text: str, kind: str = "root", labels: tuple[str, ...] = ()) -> Block:
    block = Block(kind, labels, text)
    index, size = 0, len(text)
    while index < size:
        while index < size and text[index] in " \t\r\n":
            index += 1
        if index >= size:
            break
        match = IDENTIFIER.match(text, index)
        if not match:
            raise ValueError(f"unexpected HCL near {text[index:index + 30]!r}")
        name, index = match.group(), match.end()
        while index < size and text[index] in " \t":
            index += 1
        if text.startswith("=", index) and not text.startswith("==", index):
            value, index = read_value(text, index + 1)
            block.attrs[name] = value
            continue
        found: list[str] = []
        while index < size and text[index] == '"':
            end = skip_string(text, index)
            found.append(text[index + 1:end - 1])
            index = end
            while index < size and text[index] in " \t":
                index += 1
        if index >= size or text[index] != "{":
            raise ValueError(f"expected block body for {name}")
        end = matching_brace(text, index)
        block.blocks.append(parse_body(text[index + 1:end], name, tuple(found)))
        index = end + 1
    return block


def unquote(value: str) -> str:
    return value[1:-1] if len(value) >= 2 and value[0] == value[-1] == '"' else value


def list_items(value: str) -> list[str]:
    inner = value.strip()
    if not (inner.startswith("[") and inner.endswith("]")):
        raise ValueError(f"not a list: {value!r}")
    items, depth, current = [], 0, []
    index, inner = 0, inner[1:-1]
    while index < len(inner):
        char = inner[index]
        if char == '"':
            end = skip_string(inner, index)
            current.append(inner[index:end])
            index = end
            continue
        if char in "([{":
            depth += 1
        elif char in ")]}":
            depth -= 1
        if char == "," and depth == 0:
            items.append("".join(current).strip())
            current = []
        else:
            current.append(char)
        index += 1
    tail = "".join(current).strip()
    if tail:
        items.append(tail)
    return [unquote(item) for item in items]


class Configuration:
    def __init__(self, directory: Path):
        self.files = {path.name: strip_comments(path.read_text()) for path in sorted(directory.glob("*.tf"))}
        self.root = Block("root", (), "\n".join(self.files.values()))
        for text in self.files.values():
            self.root.blocks.extend(parse_body(text).blocks)

    def resources(self, type_name: str) -> dict[str, Block]:
        return {block.labels[1]: block for block in self.root.children("resource") if block.labels[0] == type_name}

    def all_resources(self) -> list[Block]:
        return self.root.children("resource")

    def outputs(self) -> dict[str, Block]:
        return {block.labels[0]: block for block in self.root.children("output")}

    def variables(self) -> dict[str, Block]:
        return {block.labels[0]: block for block in self.root.children("variable")}

    def locals(self) -> dict[str, str]:
        merged: dict[str, str] = {}
        for block in self.root.children("locals"):
            merged.update(block.attrs)
        return merged

    def members(self) -> list[str]:
        found = []
        for block in self.all_resources():
            if "member" in block.attrs:
                found.append(unquote(block.attrs["member"]))
            if "members" in block.attrs:
                found.extend(list_items(block.attrs["members"]))
        return found


def invoker_edges(config: Configuration) -> set[tuple[str, str]]:
    """Every project-level run.invoker grant as (caller identity, exact receiver)."""
    edges = set()
    for name, block in config.resources("google_project_iam_member").items():
        if unquote(block.attrs.get("role", "")) != "roles/run.invoker":
            continue
        condition = block.child("condition")
        if condition is None:
            raise AssertionError(f"{name} grants run.invoker project-wide without an exact resource condition")
        match = EXACT_RESOURCE.match(unquote(condition.attrs["expression"]))
        if match is None:
            raise AssertionError(f"{name} run.invoker condition is not an exact portal resource name")
        kind, receiver = match.groups()
        if receiver == "${each.value.receiver}":
            for _, caller, target in EDGE.findall(config.locals()["invoker_edges"]):
                edges.add((caller, f"{kind}/{target}"))
        else:
            caller = RUNTIME_MEMBER.search(block.attrs["member"])
            if caller is None:
                raise AssertionError(f"{name} grants run.invoker to something other than a runtime identity")
            edges.add((caller.group(1), f"{kind}/{receiver}"))
    return edges


class ParserTests(unittest.TestCase):
    def test_parser_handles_interpolated_quotes_one_line_blocks_and_comments(self):
        parsed = parse_body(strip_comments('''
          resource "google_x" "y" { # trailing comment
            member = "serviceAccount:${google_service_account.runtime["deployment"].email}"
            ports { container_port = 8080 }
            limits = { cpu = "1", memory = "256Mi" }
            names  = ["a", "b"]
          }
        '''))
        block = parsed.blocks[0]
        self.assertEqual((block.kind, block.labels), ("resource", ("google_x", "y")))
        self.assertEqual(block.attrs["member"], '"serviceAccount:${google_service_account.runtime["deployment"].email}"')
        self.assertEqual(block.child("ports").attrs["container_port"], "8080")
        self.assertEqual(block.attrs["limits"], '{ cpu = "1", memory = "256Mi" }')
        self.assertEqual(list_items(block.attrs["names"]), ["a", "b"])

    def test_invoker_extraction_rejects_an_unconditioned_or_missing_grant(self):
        class Fake(Configuration):
            def __init__(self, text): self.root = parse_body(strip_comments(text)); self.files = {"x.tf": text}
        unconditioned = Fake('resource "google_project_iam_member" "x" {\n role = "roles/run.invoker"\n member = "serviceAccount:${google_service_account.runtime["web"].email}"\n}')
        with self.assertRaisesRegex(AssertionError, "project-wide"):
            invoker_edges(unconditioned)
        partial = Fake('resource "google_project_iam_member" "x" {\n role = "roles/run.invoker"\n member = "serviceAccount:${google_service_account.runtime["web"].email}"\n condition {\n title = "t"\n expression = "resource.name == \'projects/${var.project_id}/locations/${var.region}/services/portal-query\'"\n }\n}')
        self.assertEqual(invoker_edges(partial), {("web", "services/portal-query")})
        self.assertNotEqual(invoker_edges(partial), FoundationTests.EXPECTED_INVOKER_EDGES)


class FoundationTests(unittest.TestCase):
    EXPECTED_INVOKER_EDGES = {
        ("web", "services/portal-query"),
        ("web", "services/portal-actions"),
        ("web", "services/portal-ingest"),
        ("ingest", "services/portal-query"),
        ("scheduler", "services/portal-ingest"),
        ("maintenance", "jobs/portal-retention"),
    }

    @classmethod
    def setUpClass(cls):
        cls.config = Configuration(HERE)
        cls.text = "\n".join(cls.config.files.values())

    def test_state_backend_is_a_partial_gcs_configuration(self):
        terraform = next(block for block in self.config.root.children("terraform"))
        backend = terraform.child("backend")
        self.assertIsNotNone(backend)
        self.assertEqual(backend.labels, ("gcs",))
        self.assertEqual(backend.attrs, {}, "bucket and prefix come from -backend-config, never a tracked file")
        readme = (HERE / "README.md").read_text()
        self.assertIn("-backend-config", readme)
        self.assertIn("prefix=portal/", readme)

    def test_every_declared_variable_is_referenced_outside_its_declaration(self):
        for name, declaration in self.config.variables().items():
            with self.subTest(variable=name):
                elsewhere = [block.raw for block in self.config.root.blocks if block is not declaration]
                self.assertTrue(any(re.search(rf"\bvar\.{name}\b", raw) for raw in elsewhere), f"var.{name} is declared but unused")

    def test_invoker_grants_are_exactly_the_forwarding_edges_and_nothing_is_public(self):
        self.assertEqual(invoker_edges(self.config), self.EXPECTED_INVOKER_EDGES)
        for kind in ("google_project_iam_binding", "google_project_iam_policy", "google_cloud_run_v2_service_iam_policy", "google_cloud_run_v2_service_iam_binding"):
            self.assertEqual(self.config.resources(kind), {}, f"{kind} would replace the exact per-member grants")
        for name, block in self.config.resources("google_cloud_run_v2_service_iam_member").items():
            with self.subTest(service_member=name):
                self.assertEqual(unquote(block.attrs["role"]), "roles/run.invoker")
                self.assertEqual(unquote(block.attrs["member"]), IAP_SERVICE_AGENT, "only the IAP service agent may hold a service-level invoker grant")
        for member in self.config.members():
            self.assertNotIn(member, {"allUsers", "allAuthenticatedUsers"})
        self.assertNotIn("allUsers", self.text)
        self.assertNotIn("allAuthenticatedUsers", self.text)

    def test_iap_protects_the_real_web_service_entry_and_terraform_owns_only_its_shell(self):
        services = self.config.resources("google_cloud_run_v2_service")
        web = services["web"]
        self.assertNotIn("count", web.attrs, "the web entry is unconditional; only the probe is optional")
        self.assertEqual(unquote(web.attrs["name"]), "portal-web")
        self.assertEqual(web.attrs["provider"], "google-beta")
        self.assertEqual(web.attrs["iap_enabled"], "true")
        self.assertEqual(unquote(web.attrs["ingress"]), "INGRESS_TRAFFIC_ALL")
        ignored = list_items(web.child("lifecycle").attrs["ignore_changes"])
        for owned_by_controller in ("template", "traffic"):
            self.assertIn(owned_by_controller, ignored)
        self.assertNotIn("iap_enabled", ignored)
        self.assertNotIn("ingress", ignored)
        for name, service in services.items():
            with self.subTest(service=name):
                self.assertEqual(service.attrs["iap_enabled"], "true")
                self.assertIn("template", list_items(service.child("lifecycle").attrs["ignore_changes"]))
        binding = self.config.resources("google_iap_web_cloud_run_service_iam_binding")["web_group"]
        self.assertNotIn("count", binding.attrs)
        self.assertEqual(binding.attrs["cloud_run_service_name"], "google_cloud_run_v2_service.web.name")
        self.assertEqual(unquote(binding.attrs["role"]), "roles/iap.httpsResourceAccessor")
        self.assertEqual(list_items(binding.attrs["members"]), ["group:${var.iap_workspace_group}"])
        invoker = self.config.resources("google_cloud_run_v2_service_iam_member")["web_iap_invoker"]
        self.assertNotIn("count", invoker.attrs)
        self.assertEqual(invoker.attrs["name"], "google_cloud_run_v2_service.web.name")
        for deprecated in ("google_iap_client", "google_iap_brand"):
            self.assertEqual(self.config.resources(deprecated), {}, f"{deprecated} is deprecated and non-functional; IAP uses the Google-managed OAuth client")
        self.assertIn("run.googleapis.com/iap-enabled", release.FOUNDATION_SERVICE_ANNOTATIONS)
        self.assertEqual(release.IAP_SERVICES, {"portal-web"})

    def test_audiences_are_outputs_derived_from_the_foundation(self):
        outputs = self.config.outputs()
        for name in ("service_audiences", "service_urls", "web_url", "source_database_client_tag"):
            self.assertIn(name, outputs)
        self.assertNotIn("iap_client_id", outputs)
        self.assertEqual(outputs["service_audiences"].attrs["value"], "local.service_audiences")
        locals_ = self.config.locals()
        self.assertIn("google_cloud_run_v2_service.web.name", locals_["service_audiences"])
        self.assertIn("/locations/${var.region}/services/", locals_["service_audiences"])
        self.assertIn("${data.google_project.current.number}.${var.region}.run.app", locals_["service_urls"])
        receivers = set(list_items(re.search(r"toset\((\[.*?\])\)", locals_["receiver_services"]).group(1)))
        expected = {receiver for mapping in release.AUDIENCE_ENVIRONMENT.values() for receiver in mapping.values()} - {"portal-web"}
        self.assertTrue(expected <= receivers, f"release.py expects audiences for {sorted(expected - receivers)}")
        self.assertEqual(unquote(locals_["source_database_client_tag"]), release.SOURCE_DATABASE_CLIENT_TAG)

    def test_private_source_path_uses_the_declared_cidrs_over_peering_not_nat(self):
        firewalls = self.config.resources("google_compute_firewall")
        allow = firewalls["source_database_egress"]
        self.assertEqual(unquote(allow.attrs["direction"]), "EGRESS")
        self.assertEqual(allow.attrs["destination_ranges"], "var.private_source_cidrs")
        self.assertEqual(list_items(allow.attrs["target_tags"]), ["local.source_database_client_tag"])
        self.assertIsNone(allow.child("deny"))
        rule = allow.child("allow")
        self.assertEqual(unquote(rule.attrs["protocol"]), "tcp")
        self.assertEqual(list_items(rule.attrs["ports"]), ["local.source_database_port"])
        self.assertEqual(unquote(self.config.locals()["source_database_port"]), "5432")
        deny = firewalls["source_database_egress_deny"]
        self.assertEqual(deny.attrs["destination_ranges"], "var.private_source_cidrs")
        self.assertNotIn("target_tags", deny.attrs, "every untagged unit is denied the listener")
        self.assertLess(int(allow.attrs["priority"]), int(deny.attrs["priority"]))
        self.assertIsNone(deny.child("allow"))
        peerings = self.config.resources("google_compute_network_peering")
        self.assertEqual(set(peerings), {"portal_to_source", "source_to_portal"})
        self.assertEqual(peerings["portal_to_source"].attrs["peer_network"], "var.private_source_network")
        self.assertEqual(peerings["source_to_portal"].attrs["network"], "var.private_source_network")
        self.assertEqual(self.config.resources("google_compute_router_nat"), {}, "Kanban's private path is peering; there is no NAT toward the listener")
        self.assertNotIn("0.0.0.0/0", self.text)
        for name, block in self.config.resources("google_compute_subnetwork").items():
            with self.subTest(subnet=name):
                self.assertEqual(block.attrs["private_ip_google_access"], "true")

    def test_runtime_identities_are_separate_and_never_project_runtime_admins(self):
        locals_ = self.config.locals()
        self.assertEqual(set(list_items(re.search(r"toset\((\[.*?\])\)", locals_["runtime_identities"]).group(1))), {"deployment", "web", "query", "ingest", "parser", "migration", "maintenance", "scheduler"})
        roles = {unquote(block.attrs["role"]) for block in self.config.all_resources() if "role" in block.attrs}
        for forbidden in ("roles/run.admin", "roles/owner", "roles/editor", "roles/iam.serviceAccountKeyAdmin"):
            self.assertNotIn(forbidden, roles)
        self.assertNotIn("google_service_account_key", {block.labels[0] for block in self.config.all_resources()})

    def test_secret_access_matrix_gives_database_identities_the_listener_ca_and_nothing_to_web_or_parser(self):
        access = {identity: [unquote(item) for item in list_items(f"[{items}]")] for identity, items in ACCESS.findall(self.config.locals()["secret_access"])}
        self.assertEqual(access["web"], [])
        self.assertEqual(access["parser"], [])
        for identity in ("query", "ingest", "migration", "maintenance"):
            with self.subTest(identity=identity):
                self.assertIn("portal-source-database-ca", access[identity])
                self.assertTrue(any(secret.endswith("-db-url") for secret in access[identity]))
        self.assertEqual(access["maintenance"], ["portal-maintenance-db-url", "portal-source-database-ca"])
        self.assertNotIn("portal-parser-key", self.text)
        self.assertNotIn("versions/latest", self.text)

    def test_only_query_can_read_the_redis_ca_secret(self):
        locals_ = self.config.locals()
        secret_names = set(list_items(re.search(r"toset\((\[.*?\])\)", locals_["secret_names"], re.S).group(1)))
        self.assertIn("portal-redis-ca", secret_names)
        access = {identity: list_items(f"[{items}]") for identity, items in ACCESS.findall(locals_["secret_access"])}
        self.assertEqual({identity for identity, secrets in access.items() if "portal-redis-ca" in secrets}, {"query"})
        container = self.config.resources("google_secret_manager_secret")["runtime"]
        self.assertEqual(container.attrs["for_each"], "local.secret_names")
        self.assertEqual(container.child("lifecycle").attrs["prevent_destroy"], "true")
        grant = self.config.resources("google_secret_manager_secret_iam_member")["runtime"]
        self.assertEqual(grant.attrs["for_each"], "local.secret_grants")
        self.assertEqual(unquote(grant.attrs["role"]), "roles/secretmanager.secretAccessor")
        self.assertEqual(grant.attrs["secret_id"], "google_secret_manager_secret.runtime[each.value.secret].secret_id")
        self.assertEqual(unquote(grant.attrs["member"]), 'serviceAccount:${google_service_account.runtime[each.value.identity].email}')

    def test_private_storage_and_networking_have_no_public_data_path(self):
        bucket = self.config.resources("google_storage_bucket")["portal"]
        self.assertEqual(unquote(bucket.attrs["public_access_prevention"]), "enforced")
        self.assertEqual(bucket.attrs["uniform_bucket_level_access"], "true")
        redis = self.config.resources("google_redis_instance")["portal"]
        self.assertEqual(unquote(redis.attrs["transit_encryption_mode"]), "SERVER_AUTHENTICATION")
        for name, service in self.config.resources("google_cloud_run_v2_service").items():
            with self.subTest(service=name):
                self.assertEqual(unquote(service.child("template").child("vpc_access").attrs["egress"]), "ALL_TRAFFIC")

    def test_parser_and_ingest_have_only_the_object_and_job_access_they_use(self):
        grants = {name: (unquote(block.attrs["role"]), RUNTIME_MEMBER.search(block.attrs["member"]).group(1)) for name, block in self.config.resources("google_storage_bucket_iam_member").items()}
        self.assertEqual(grants["parser_write"], ("roles/storage.objectCreator", "parser"))
        self.assertEqual(grants["parser_read"], ("roles/storage.objectViewer", "parser"))
        self.assertEqual(grants["ingest_read"], ("roles/storage.objectViewer", "ingest"))
        self.assertEqual(grants["ingest_write"], ("roles/storage.objectCreator", "ingest"))
        self.assertNotIn("query", {identity for _, identity in grants.values()})
        reader = self.config.resources("google_project_iam_custom_role")["parser_operation_reader"]
        self.assertEqual(list_items(reader.attrs["permissions"]), ["run.operations.get"])

    def test_ingest_can_run_parser_with_overrides_but_cannot_manage_jobs(self):
        roles = self.config.resources("google_project_iam_custom_role")
        self.assertIn("parser_job_executor", roles)
        executor = roles["parser_job_executor"]
        self.assertEqual(set(list_items(executor.attrs["permissions"])), {"run.jobs.run", "run.jobs.runWithOverrides"})
        members = self.config.resources("google_project_iam_member")
        grants = [block for block in members.values() if block.attrs["role"] == "google_project_iam_custom_role.parser_job_executor.name"]
        self.assertEqual(len(grants), 1)
        grant = grants[0]
        self.assertEqual(grant.attrs["project"], "var.project_id")
        self.assertEqual(unquote(grant.attrs["member"]), 'serviceAccount:${google_service_account.runtime["ingest"].email}')
        condition = grant.child("condition")
        self.assertIsNotNone(condition)
        self.assertEqual(unquote(condition.attrs["expression"]), "resource.name == 'projects/${var.project_id}/locations/${var.region}/jobs/portal-parser'")
        reader = members["ingest_parser_operation_reader"]
        self.assertEqual(reader.attrs["role"], "google_project_iam_custom_role.parser_operation_reader.name")
        self.assertEqual(reader.attrs["member"], grant.attrs["member"])
        self.assertIsNone(reader.child("condition"), "operation names do not carry the parser job name")

    def test_maintenance_alone_can_delete_retained_objects(self):
        deleter = self.config.resources("google_project_iam_custom_role")["retention_object_deleter"]
        self.assertEqual(list_items(deleter.attrs["permissions"]), ["storage.objects.delete"])
        holders = [RUNTIME_MEMBER.search(block.attrs["member"]).group(1) for block in self.config.resources("google_storage_bucket_iam_member").values() if block.attrs["role"] == "google_project_iam_custom_role.retention_object_deleter.name"]
        self.assertEqual(holders, ["maintenance"])
        self.assertIn("retention", self.config.resources("google_cloud_scheduler_job"))

    def test_outbox_scheduler_starts_paused_and_has_only_its_exact_ingest_edge(self):
        jobs = self.config.resources("google_cloud_scheduler_job")
        self.assertIn("outbox", jobs)
        job = jobs["outbox"]
        self.assertEqual(job.attrs["for_each"], 'toset(["drain", "check"])')
        self.assertEqual(unquote(job.attrs["name"]), "portal-outbox-${each.value}")
        self.assertEqual(unquote(job.attrs["schedule"]), "* * * * *")
        self.assertEqual(unquote(job.attrs["time_zone"]), "Etc/UTC")
        self.assertEqual(unquote(job.attrs["attempt_deadline"]), "450s")
        self.assertEqual(job.attrs["paused"], "true")
        self.assertEqual(list_items(job.child("lifecycle").attrs["ignore_changes"]), ["paused"])
        retries = job.child("retry_config")
        self.assertIsNotNone(retries, "Explicit API defaults must preserve the retry block returned after updates")
        self.assertEqual(retries.attrs, {
            "retry_count": "0",
            "max_retry_duration": '"0s"',
            "min_backoff_duration": '"5s"',
            "max_backoff_duration": '"3600s"',
            "max_doublings": "5",
        }, "Both zero retry limits disable retries; nonempty backoff defaults keep provider serialization stable")
        target = job.child("http_target")
        self.assertEqual(unquote(target.attrs["http_method"]), "POST")
        self.assertNotIn("body", target.attrs, "scheduler endpoints accept no request body")
        self.assertEqual(unquote(target.attrs["uri"]), '${local.service_urls["portal-ingest"]}/internal/outbox/${each.value}')
        token = target.child("oidc_token")
        self.assertEqual(token.attrs["service_account_email"], 'google_service_account.runtime["scheduler"].email')
        self.assertEqual(token.attrs["audience"], 'local.service_urls["portal-ingest"]')
        self.assertIsNone(target.child("oauth_token"))
        self.assertEqual({edge for edge in invoker_edges(self.config) if edge[0] == "scheduler"}, {("scheduler", "services/portal-ingest")})
        self.assertNotIn("scheduler", {identity for identity, _ in ACCESS.findall(self.config.locals()["secret_access"])})
        output = self.config.outputs()["outbox_scheduler"].attrs["value"]
        self.assertIn('google_service_account.runtime["scheduler"].unique_id', output)
        self.assertIn('google_cloud_scheduler_job.outbox["check"].id', output)
        self.assertIn('google_cloud_scheduler_job.outbox["drain"].id', output)

    def test_only_ingest_can_write_the_predeclared_database_metric(self):
        roles = self.config.resources("google_project_iam_custom_role")
        self.assertIn("ingest_metrics_writer", roles)
        self.assertEqual(list_items(roles["ingest_metrics_writer"].attrs["permissions"]), ["monitoring.timeSeries.create"])
        grants = [block for block in self.config.resources("google_project_iam_member").values() if block.attrs["role"] == "google_project_iam_custom_role.ingest_metrics_writer.name"]
        self.assertEqual(len(grants), 1)
        self.assertEqual(unquote(grants[0].attrs["member"]), 'serviceAccount:${google_service_account.runtime["ingest"].email}')
        self.assertEqual(self.config.outputs()["database_connection_utilization_metric_type"].attrs["value"], "var.database_connection_utilization_metric_type")

    def test_content_free_operational_alerts_cover_critical_stages(self):
        monitoring = (HERE / "monitoring.tf").read_text()
        for signal in ("authentication", "source", "model", "cache", "indexing", "retention", "security"):
            with self.subTest(signal=signal):
                self.assertIn(f'jsonPayload.stage=\\"{signal}\\"', monitoring)
        self.assertIn("database_connection_utilization_metric_type", monitoring)
        # Backlog ages and latency are read from the flat telemetry record, never from a nested object.
        self.assertIn("EXTRACT(jsonPayload.durationMs)", monitoring)
        self.assertIn("EXTRACT(jsonPayload.${each.value.field})", monitoring)
        for metric in ("lagSeconds", "queueSeconds"):
            with self.subTest(metric=metric):
                self.assertIn(f'field       = "{metric}"', monitoring)
        self.assertNotIn("jsonPayload.metrics.", monitoring)
        self.assertIn('jsonPayload.stage=\\"security\\" AND jsonPayload.outcome=\\"error\\"', monitoring)
        telemetry = (HERE.parents[2] / "packages/portal/src/telemetry.ts").read_text()
        for token in ('"security"', '"lagSeconds"', '"queueSeconds"'):
            with self.subTest(token=token):
                self.assertIn(token, telemetry)

    def test_revision_specs_are_controller_owned_and_the_controller_is_not_a_terraform_service(self):
        self.assertIn("revision fields are controller-owned", (HERE / "services.tf").read_text())
        self.assertEqual(set(self.config.resources("google_cloud_run_v2_service")), {"probe", "web"}, "query, ingest, actions and the jobs are created only by the release controller")
        self.assertEqual(self.config.resources("google_cloud_run_v2_job"), {})

    def test_implemented_units_have_pruned_production_runtime_images(self):
        expected_commands = {
            "web": 'CMD ["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"]',
            "query": 'CMD ["node", "dist/index.js"]',
            "ingest": 'CMD ["node", "dist/index.js"]',
            "schema": 'CMD ["node", "schema/migrate.mjs"]',
            "retention": 'CMD ["node", "dist/retention-job.js"]',
        }
        for unit, command in expected_commands.items():
            dockerfile = (HERE / f"Dockerfile.{unit}").read_text()
            with self.subTest(unit=unit):
                self.assertNotIn("exit 78", dockerfile)
                self.assertIn("turbo@2.9.6 prune", dockerfile)
                self.assertIn("deploy --prod --legacy --ignore-scripts", dockerfile)
                self.assertIn(command, dockerfile)

    def test_parser_image_is_a_finite_job_not_the_ingest_server(self):
        dockerfile = (HERE / "Dockerfile.parser").read_text()
        self.assertNotIn("exit 78", dockerfile)
        self.assertIn('CMD ["node", "dist/parser-job.js"]', dockerfile)
        self.assertIn("poppler-utils", dockerfile)
        self.assertIn("tesseract-ocr", dockerfile)

    def test_web_declares_every_externalized_runtime_import(self):
        manifest = json.loads((HERE.parents[2] / "apps/portal/package.json").read_text())
        self.assertEqual(manifest["dependencies"].get("zod"), "catalog:")


if __name__ == "__main__":
    unittest.main()
