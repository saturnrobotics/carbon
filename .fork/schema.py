"""Prove schema provenance using only newly allocated, labeled Docker projects.

The source revision and previous release are immutable Git inputs. No URL, existing
container, stack slug, or developer database can be supplied to this entry point.
"""

import argparse
import base64
import copy
import hashlib
import hmac
import http.server
import io
import json
import os
from pathlib import Path
import re
import runpy
import signal
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import uuid

MIGRATIONS = "packages/database/supabase/migrations/"
OWNER_LABEL = "carbon.fork.schema-run"
COMPOSE_INPUT = "packages/dev/docker/docker-compose.dev.yml"
BOOTSTRAP_INPUT = "packages/dev/docker/init.sql"
HINT_TRANSITION = "disable-supautils-permission-hints"
HINT_ARGUMENT = "supautils.hint_roles="
SERVICES = ("postgres", "gotrue", "storage", "postgrest", "meta")
ARTIFACTS = {
    "types": "packages/database/src/types.ts",
    "function-types": "packages/database/supabase/functions/lib/types.ts",
    "swagger": "packages/database/src/swagger-docs-schema.ts",
    "backup": "packages/jobs/manifests/schema.json",
}
GENERATION_PATTERNS = (
    ".fork/schema.py",
    ".fork/schema-*.ts",
    ".fork/tests/schema-*.test.ts",
    ".fork/verify.py",
    ".fork/generated-artifacts.json",
    "scripts/generate-db-types.ts",
    "scripts/generate-swagger-docs.ts",
    "scripts/lib/*.ts",
    "scripts/lib/*.sql",
    "packages/jobs/src/backups/**/*.ts",
    "package.json",
    "packages/jobs/package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
)


def check_artifact_inventory(registry):
    expected = {
        "db-types": {ARTIFACTS["types"], ARTIFACTS["function-types"]},
        "swagger": {ARTIFACTS["swagger"]},
        "backup-schema": {ARTIFACTS["backup"]},
    }
    seen = set()
    for artifact in registry["artifacts"]:
        if artifact.get("group") not in ("schema", "schema-manifest"):
            continue
        identifier = artifact["id"]
        if (
            identifier in seen
            or identifier not in expected
            or set(artifact.get("tracked", [])) != expected[identifier]
        ):
            raise ValueError(f"schema artifact inventory unsupported: {identifier}")
        seen.add(identifier)
    if seen != set(expected):
        raise ValueError("schema artifact inventory is incomplete")


def check_platform_inputs(base, candidate):
    """Compare full resolved Compose definitions and immutable bootstrap bytes."""
    if base == candidate:
        return None
    try:
        if (
            set(base) != {COMPOSE_INPUT, BOOTSTRAP_INPUT}
            or set(candidate) != set(base)
            or base[BOOTSTRAP_INPUT] != candidate[BOOTSTRAP_INPUT]
        ):
            raise ValueError
        original = base[COMPOSE_INPUT]
        changed = copy.deepcopy(candidate[COMPOSE_INPUT])
        old_command = original["services"]["postgres"]["command"]
        command = changed["services"]["postgres"]["command"]
        if (
            not isinstance(old_command, list)
            or not isinstance(command, list)
            or any(not isinstance(arg, str) for arg in old_command + command)
            or any("supautils.hint_roles" in arg for arg in old_command)
            or sum("supautils.hint_roles" in arg for arg in command) != 1
            or command.count(HINT_ARGUMENT) != 1
        ):
            raise ValueError
        index = command.index(HINT_ARGUMENT)
        if index == 0 or command[index - 1] != "-c":
            raise ValueError
        del command[index - 1 : index + 1]
        if changed != original:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise ValueError(
            "platform upgrade requires a dedicated transition test; unsupported platform change"
        ) from None
    return HINT_TRANSITION


def check_transition_continuity(before, after):
    required = {"owner", "data", "system", "migrations", "schema", "volumes"}
    if (
        set(before) != required
        or not before["owner"]
        or not before["data"]
        or before != after
    ):
        raise ValueError(
            "platform transition continuity failed: persisted state changed"
        )


def check_denied_execute(result):
    try:
        privileges = json.loads(result.stdout)
    except (ValueError, UnicodeError):
        privileges = {}
    if (
        result.returncode != 3
        or not isinstance(privileges, dict)
        or set(privileges) != {"usage", "execute"}
        or privileges.get("usage") is not True
        or privileges.get("execute") is not False
        or not re.search(r"^ERROR:\s+42501:", result.stderr, re.MULTILINE)
    ):
        raise ValueError(
            "platform permission probe failed: expected denied EXECUTE with SQLSTATE 42501"
        )


def check_committed_inputs(committed, current):
    if committed != current:
        raise ValueError(
            "uncommitted generation inputs cannot attest HEAD; use --regenerate for unverified disposable outputs, review and commit, then verify"
        )


def generation_inputs(root):
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for pattern in GENERATION_PATTERNS
        for path in root.glob(pattern)
        if path.is_file()
    }


def check_revision_inputs(root, revision):
    current = generation_inputs(root)
    tracked = set(
        git(root, "ls-tree", "-r", "--name-only", revision).decode().splitlines()
    )
    matches = runpy.run_path(str(Path(__file__).with_name("verify.py")))["matches"]
    check_committed_inputs(
        {
            path: git(root, "show", f"{revision}:{path}")
            for path in tracked
            if matches(path, GENERATION_PATTERNS)
        },
        current,
    )


def check_upgrade_baseline(root, base, revision, *, regenerate=False):
    if base == revision and not regenerate:
        raise ValueError("upgrade baseline must precede the candidate")
    git(root, "merge-base", "--is-ancestor", base, revision)


def supabase_pin(catalog):
    """Read the default catalog's exact pin; unsupported/ambiguous forms fail closed."""
    sections = 0
    active = False
    pins = []
    for line in catalog.splitlines():
        if line and not line.startswith((b" ", b"\t", b"#")):
            active = line.rstrip() == b"catalog:"
            sections += bool(re.match(rb"^(['\"]?)catalog\1[ \t]*:", line))
        key = re.match(rb"^  (['\"]?)supabase\1[ \t]*:", line)
        if active and key:
            pins.append(line[key.end() :].strip())
    match = (
        re.fullmatch(
            rb"(['\"]?)([0-9]+\.[0-9]+\.[0-9]+)\1(?:[ \t]+#[^\r\n]*)?", pins[0]
        )
        if sections == 1 and len(pins) == 1
        else None
    )
    if not match:
        raise ValueError(
            "Supabase CLI pin must be one exact version in pnpm-workspace.yaml catalog"
        )
    return match[2].decode()


def studio_schema_adapter(payload, proof_sql, query):
    class StudioSchemaAdapter(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/api/platform/pg-meta/default/query":
                self.send_error(404)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 1_000_000:
                    raise ValueError("invalid request length")
                body = self.rfile.read(length)
                if json.loads(body) != {"query": proof_sql}:
                    raise ValueError("unexpected catalog query")
            except (ValueError, UnicodeError):
                self.send_error(400)
                return
            try:
                result = json.dumps(query(body)).encode()
            except (OSError, ValueError):
                self.send_error(502, "Allocated catalog proof unavailable")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(result)

        def do_GET(self):
            if self.path != "/api/platform/projects/default/api/rest":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, format, *args):
            pass

    return StudioSchemaAdapter


def bootstrap_ready(tables_ready, services):
    return (
        tables_ready
        and services.get("gotrue") is True
        and services.get("storage") is True
    )


def migration_manifest(files):
    manifest = {}
    for path, content in sorted(files.items()):
        match = re.fullmatch(re.escape(MIGRATIONS) + r"(\d{14})_[^/]+\.sql", path)
        if not match:
            raise ValueError(f"invalid migration filename: {path}")
        version = match[1]
        if version in manifest:
            raise ValueError(f"duplicate migration identity: {version}")
        manifest[version] = {
            "path": path,
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    return manifest


def check_history(base, candidate):
    migration_manifest(base)
    migration_manifest(candidate)
    for path, content in base.items():
        if candidate.get(path) != content:
            raise ValueError(f"historical migration changed or missing: {path}")


def check_applied(expected, actual):
    if len(actual) != len(set(actual)):
        raise ValueError("duplicate applied migration identity")
    missing = set(expected) - set(actual)
    extra = set(actual) - set(expected)
    if missing or extra:
        raise ValueError(
            f"migration ledger mismatch: {len(missing)} missing, {len(extra)} extra"
        )


def schema_fingerprint(source):
    # pg_dump's random session tokens are transport guards, not schema. Retain
    # definitions, ACLs, ownership, policies and every line of function bodies.
    lines = source.splitlines()
    statements = [
        i for i, line in enumerate(lines) if line.strip() and not line.startswith("--")
    ]
    if statements:
        first, last = statements[0], statements[-1]
        guard = re.fullmatch(r"\\restrict (\S+)", lines[first])
        if guard and lines[last] == "\\unrestrict " + guard[1]:
            lines = [line for i, line in enumerate(lines) if i not in (first, last)]
    normalized = "\n".join(lines)
    return hashlib.sha256(normalized.encode()).hexdigest()


def assert_owned(project, resources):
    if not re.fullmatch(r"carbon-fork-schema-[a-z0-9-]+", project):
        raise ValueError("invalid disposable project ownership identifier")
    for resource in resources:
        labels = (
            resource.get("Labels") or resource.get("Config", {}).get("Labels") or {}
        )
        if (
            labels.get(OWNER_LABEL) != project
            or labels.get("com.docker.compose.project") != project
        ):
            raise ValueError("resource ownership mismatch; cleanup refused")


def sanitize_compose(config, project, bootstrap):
    assert_owned(project, [])
    services = {}
    for name in SERVICES:
        original = config.get("services", {}).get(name, {})
        image = original.get("image", "")
        if not re.search(r":(?:v?\d)[^\s]*$|@sha256:[a-f0-9]{64}$", image):
            raise ValueError(f"missing or unpinned service image: {name}")
        service = {
            key: copy.deepcopy(original[key])
            for key in ("image", "environment", "command", "healthcheck", "depends_on")
            if key in original
        }
        service["restart"] = "no"
        service["labels"] = {OWNER_LABEL: project}
        service.setdefault("environment", {})
        if name != "postgres":
            service["depends_on"] = {"postgres": {"condition": "service_healthy"}}
        if name in SERVICES:
            port = {
                "postgres": 5432,
                "postgrest": 3000,
                "meta": 8080,
                "gotrue": 9999,
                "storage": 5000,
            }[name]
            service["ports"] = [
                {"target": port, "published": "0", "host_ip": "127.0.0.1"}
            ]
        services[name] = service
    for name, variable, user in (
        ("gotrue", "GOTRUE_DB_DATABASE_URL", "supabase_auth_admin"),
        ("storage", "DATABASE_URL", "supabase_storage_admin"),
        ("postgrest", "PGRST_DB_URI", "authenticator"),
        ("meta", "PG_META_DB_URL", "supabase_admin"),
    ):
        services[name]["environment"][variable] = (
            f"postgresql://{user}:postgres@postgres:5432/postgres"
        )
    services["meta"]["environment"].update(
        {
            "PG_META_DB_HOST": "postgres",
            "PG_META_DB_PORT": "5432",
            "PG_META_DB_NAME": "postgres",
            "PG_META_DB_USER": "supabase_admin",
            "PG_META_DB_PASSWORD": "postgres",
        }
    )
    services["storage"]["environment"]["POSTGREST_URL"] = "http://postgrest:3000"
    services["postgres"]["volumes"] = [
        "pgdata:/var/lib/postgresql/data",
        "pgconfig:/etc/postgresql-custom",
        {
            "type": "bind",
            "source": str(bootstrap),
            "target": "/docker-entrypoint-initdb.d/zz-carbon-roles.sql",
            "read_only": True,
        },
    ]
    services["storage"]["volumes"] = ["storage:/var/lib/storage"]
    gotrue = services["gotrue"]["environment"]
    for key in ("SSL_CERT_FILE", "GOTRUE_SAML_PRIVATE_KEY"):
        gotrue.pop(key, None)
    gotrue.update(
        {
            "GOTRUE_EXTERNAL_GOOGLE_ENABLED": "false",
            "GOTRUE_EXTERNAL_AZURE_ENABLED": "false",
            "GOTRUE_SAML_ENABLED": "false",
            "GOTRUE_DISABLE_SIGNUP": "true",
        }
    )
    return {
        "services": services,
        "networks": {"default": {"labels": {OWNER_LABEL: project}}},
        "volumes": {
            name: {"labels": {OWNER_LABEL: project}}
            for name in ("pgdata", "pgconfig", "storage")
        },
    }


def clean_environment():
    # Keep Docker/Node discovery, never inherit application credentials or a
    # caller-selected remote Docker endpoint / Compose project / database URL.
    keys = ("PATH", "HOME", "USER", "TMPDIR", "DOCKER_CONFIG", "XDG_CONFIG_HOME")
    return {
        **{key: os.environ[key] for key in keys if key in os.environ},
        "CI": "1",
        "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
        "NO_COLOR": "1",
    }


def run(args, *, cwd, env, label, input=None, timeout=1200):
    try:
        result = subprocess.run(
            [str(arg) for arg in args],
            cwd=cwd,
            env=env,
            input=input,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"{label}: unavailable or timed out") from error
    if result.returncode:
        # Error output stays in the private allocation log; command arguments
        # can contain its synthetic credential-bearing DB URL.
        log_directory = Path(
            env.get("FORK_SCHEMA_LOG_DIR", str(Path(cwd) / ".fork/local/schema-errors"))
        )
        log_directory.mkdir(parents=True, exist_ok=True)
        log = log_directory / "schema-error.log"
        log.write_bytes(result.stdout + result.stderr)
        migration = re.findall(
            rb"Applying migration ([0-9]{14}_[^\s]+\.sql)", result.stderr
        )
        suffix = f" at {migration[-1].decode()}" if migration else ""
        raise ValueError(
            f"{label} failed (exit {result.returncode}){suffix}; diagnostic: {log}"
        )
    return result.stdout


def git(root, *args):
    return run(
        ["git", "-C", root, *args],
        cwd=root,
        env=clean_environment(),
        label="Git snapshot",
    )


def migrations_at(root, revision):
    archive = git(root, "archive", revision, MIGRATIONS)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        return {
            member.name: tar.extractfile(member).read()
            for member in tar.getmembers()
            if member.isfile()
        }


def jwt(secret, role):
    def segment(value):
        return base64.urlsafe_b64encode(
            json.dumps(value, separators=(",", ":")).encode()
        ).rstrip(b"=")

    message = (
        segment({"alg": "HS256", "typ": "JWT"})
        + b"."
        + segment({"iss": "supabase", "role": role})
    )
    return (
        message
        + b"."
        + base64.urlsafe_b64encode(
            hmac.new(secret.encode(), message, hashlib.sha256).digest()
        ).rstrip(b"=")
    ).decode()


class DisposableStack:
    def __init__(self, root, allocation, source_compose):
        self.root, self.directory = root, allocation
        self.project = "carbon-fork-schema-" + uuid.uuid4().hex
        self.env = clean_environment()
        self.env["PATH"] = (
            str(root / "node_modules/.bin") + os.pathsep + self.env.get("PATH", "")
        )
        self.env["NODE_PATH"] = str(root / "node_modules/.pnpm/node_modules")
        self.env["FORK_SCHEMA_LOG_DIR"] = str(allocation)
        secret = "synthetic-schema-verification-" + uuid.uuid4().hex
        self.service_key = jwt(secret, "service_role")
        self.env.update(
            {
                "SUPABASE_JWT_SECRET": secret,
                "SUPABASE_ANON_KEY": jwt(secret, "anon"),
                "SUPABASE_SERVICE_ROLE_KEY": self.service_key,
                "SUPABASE_URL": "http://example.com",
                "ERP_URL": "http://example.com",
                "MES_URL": "http://example.com",
                "GTM_URL": "http://example.com",
                "DOMAIN": "example.com",
                "INNGEST_TLS_HOST": "example.com",
                "CARBON_WORKTREE": self.project,
                "SUPABASE_AUTH_EXTERNAL_GOOGLE_REDIRECT_URI": "http://example.com",
                "SUPABASE_AUTH_EXTERNAL_AZURE_REDIRECT_URI": "http://example.com",
                **{
                    key: "0"
                    for key in (
                        "PORT_DB",
                        "PORT_STUDIO",
                        "PORT_INBUCKET",
                        "PORT_API",
                        "PORT_INNGEST",
                    )
                },
            }
        )
        self.source_compose = source_compose
        self.compose_file = self.directory / "compose.json"

    def call(self, *args, **kwargs):
        return run(args, cwd=self.directory, env=self.env, **kwargs)

    def compose_command(self, *args):
        return [
            "docker",
            "compose",
            "--project-directory",
            self.directory,
            "--env-file",
            "/dev/null",
            "-f",
            self.compose_file,
            "-p",
            self.project,
            *args,
        ]

    def compose(self, *args, **kwargs):
        return self.call(*self.compose_command(*args), **kwargs)

    def resources(self):
        result = []
        for kind, listing in (
            ("container", ["ps", "-aq"]),
            ("network", ["network", "ls", "-q"]),
            ("volume", ["volume", "ls", "-q"]),
        ):
            ids = (
                self.call(
                    "docker",
                    *listing,
                    "--filter",
                    f"label=com.docker.compose.project={self.project}",
                    label="resource ownership listing",
                )
                .decode()
                .split()
            )
            if ids:
                result.extend(
                    json.loads(
                        self.call(
                            "docker",
                            kind,
                            "inspect",
                            *ids,
                            label="resource ownership inspection",
                        )
                    )
                )
        return result

    def resolved_compose(self, source=None, *, interpolate=True):
        raw = self.call(
            "docker",
            "compose",
            "--project-directory",
            self.directory,
            "--env-file",
            "/dev/null",
            "-f",
            source or self.source_compose,
            "--profile",
            "full",
            "config",
            *([] if interpolate else ["--no-interpolate", "--no-env-resolution"]),
            "--format",
            "json",
            label="resolve pinned service definitions",
        )
        return json.loads(raw)

    def classify_platform(
        self, base_source, candidate_source, base_bootstrap, candidate_bootstrap
    ):
        transitions = []
        for interpolate in (True, False):
            transitions.append(
                check_platform_inputs(
                    {
                        COMPOSE_INPUT: self.resolved_compose(
                            base_source, interpolate=interpolate
                        ),
                        BOOTSTRAP_INPUT: base_bootstrap,
                    },
                    {
                        COMPOSE_INPUT: self.resolved_compose(
                            candidate_source, interpolate=interpolate
                        ),
                        BOOTSTRAP_INPUT: candidate_bootstrap,
                    },
                )
            )
        if transitions[0] != transitions[1]:
            raise ValueError("platform upgrade resolved and source transitions differ")
        return transitions[0]

    def start(self):
        if self.resources():
            raise ValueError(
                "disposable project collision; refusing existing resources"
            )
        config = sanitize_compose(
            self.resolved_compose(), self.project, self.directory / "init.sql"
        )
        self.compose_file.write_text(json.dumps(config))
        print(
            f"schema verification: booting allocated project {self.project}", flush=True
        )
        self.compose("up", "-d", label="disposable stack boot")
        service_urls = {
            name: f"http://127.0.0.1:{self.published_port(name, port)}{path}"
            for name, port, path in (
                ("gotrue", 9999, "/health"),
                ("storage", 5000, "/status"),
            )
        }
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            try:
                ready = self.sql(
                    "SELECT to_regclass('storage.buckets') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='auth' AND table_name='users' AND column_name='email_confirmed_at');"
                )
                services_ready = {}
                for name, url in service_urls.items():
                    try:
                        with urllib.request.urlopen(url, timeout=2) as response:
                            services_ready[name] = response.status == 200
                    except (OSError, urllib.error.URLError):
                        services_ready[name] = False
                if bootstrap_ready(ready.strip() == "t", services_ready):
                    break
            except ValueError:
                pass
            time.sleep(1)
        else:
            raise ValueError(
                "disposable auth/storage schema bootstrap did not complete"
            )
        # Their schemas have finished bootstrapping. Stop writers so snapshot
        # comparisons cannot race with platform migrations or background jobs.
        self.compose("stop", "gotrue", "storage", label="quiesce bootstrap services")
        self.sql(
            f"CREATE SCHEMA fork_verification; CREATE TABLE fork_verification.owner (id text PRIMARY KEY); INSERT INTO fork_verification.owner VALUES ('{self.project}');"
        )
        self.refresh_connection()

    def refresh_connection(self):
        self.port = self.published_port("postgres", 5432)
        self.db_url = f"postgresql://supabase_admin:postgres@127.0.0.1:{self.port}/postgres?sslmode=disable"
        self.env["SUPABASE_DB_URL"] = self.db_url

    def continuity_snapshot(self):
        resources = self.resources()
        assert_owned(self.project, resources)
        volumes = {}
        for resource in resources:
            name = resource.get("Labels", {}).get("com.docker.compose.volume")
            if name in {"pgdata", "pgconfig"}:
                if (
                    name in volumes
                    or not resource.get("Name")
                    or not resource.get("CreatedAt")
                ):
                    raise ValueError("platform continuity volume identity is ambiguous")
                volumes[name] = {key: resource[key] for key in ("Name", "CreatedAt")}
        if set(volumes) != {"pgdata", "pgconfig"}:
            raise ValueError("platform continuity volumes missing")
        owner = self.sql("SELECT id FROM fork_verification.owner ORDER BY id;").strip()
        if owner != self.project:
            raise ValueError("platform continuity owner mismatch")
        return {
            "owner": owner,
            "data": self.sql(
                "SELECT payload FROM fork_verification.transition_probe ORDER BY payload;"
            ).strip(),
            "system": self.sql(
                "SELECT system_identifier FROM pg_control_system();"
            ).strip(),
            "migrations": self.sql(
                "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;"
            ).splitlines(),
            "schema": self.fingerprint(),
            "volumes": volumes,
        }

    def wait_sql_ready(self):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                if self.sql("SELECT 1;").strip() == "1":
                    return
            except ValueError:
                pass
            time.sleep(1)
        raise ValueError("platform transition database did not become ready")

    def wait_api_ready(self):
        meta = f"http://127.0.0.1:{self.published_port('meta', 8080)}/query"
        rest = f"http://127.0.0.1:{self.published_port('postgrest', 3000)}/"
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                request = urllib.request.Request(
                    meta,
                    data=b'{"query":"SELECT 1 AS ready"}',
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    ready = json.load(response) == [{"ready": 1}]
                request = urllib.request.Request(
                    rest, headers={"Authorization": f"Bearer {self.service_key}"}
                )
                with urllib.request.urlopen(request, timeout=5) as response:
                    ready = ready and response.status == 200
                if ready:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(1)
        raise ValueError("platform transition API services did not reconnect")

    def verify_permission_errors(self):
        if self.sql("SELECT current_setting('supautils.hint_roles');").strip() != "":
            raise ValueError("platform transition hint setting was not applied")
        for role in ("anon", "authenticated"):
            # Closing the failed psql session rolls the complete probe back. A
            # top-level denied call must reach PostgreSQL's real error-output hook.
            source = f"""BEGIN;
CREATE FUNCTION public.fork_verification_denied_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';
REVOKE ALL ON FUNCTION public.fork_verification_denied_probe() FROM PUBLIC, anon, authenticated;
SET LOCAL ROLE {role};
SELECT json_build_object('usage', has_schema_privilege(current_user, 'public', 'USAGE'), 'execute', has_function_privilege(current_user, 'public.fork_verification_denied_probe()', 'EXECUTE'));
SELECT public.fork_verification_denied_probe();
"""
            try:
                result = subprocess.run(
                    self.compose_command(
                        "exec",
                        "-T",
                        "postgres",
                        "psql",
                        "-X",
                        "-U",
                        "supabase_admin",
                        "-d",
                        "postgres",
                        "-qAt",
                        "-v",
                        "ON_ERROR_STOP=1",
                        "-v",
                        "VERBOSITY=verbose",
                    ),
                    cwd=self.directory,
                    env=self.env,
                    input=source,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=30,
                )
            except (OSError, subprocess.TimeoutExpired) as error:
                raise ValueError(
                    "platform permission probe unavailable or timed out"
                ) from error
            check_denied_execute(result)
            if self.sql("SELECT 1;").strip() != "1":
                raise ValueError(
                    "platform permission probe lost the database connection"
                )
            if (
                self.sql(
                    "SELECT to_regprocedure('public.fork_verification_denied_probe()') IS NULL;"
                ).strip()
                != "t"
            ):
                raise ValueError("platform permission probe did not roll back")

    def transition_platform(self, transition, candidate_source):
        if transition != HINT_TRANSITION:
            raise ValueError("unsupported platform transition")
        bootstrap = (self.directory / "init.sql").read_bytes()
        candidate = self.resolved_compose(candidate_source)
        actual = self.classify_platform(
            self.source_compose, candidate_source, bootstrap, bootstrap
        )
        if actual != transition:
            raise ValueError("platform transition no longer matches reviewed inputs")
        assert_owned(self.project, self.resources())
        sentinel = uuid.uuid4().hex
        self.sql(
            f"CREATE TABLE fork_verification.transition_probe (payload text PRIMARY KEY); INSERT INTO fork_verification.transition_probe VALUES ('{sentinel}');"
        )
        before = self.continuity_snapshot()
        if before["data"] != sentinel:
            raise ValueError("platform transition sentinel was not persisted")
        self.compose_file.write_text(
            json.dumps(
                sanitize_compose(candidate, self.project, self.directory / "init.sql")
            )
        )
        self.compose(
            "up",
            "-d",
            "--no-deps",
            "--force-recreate",
            "postgres",
            label="same-volume platform transition",
        )
        self.wait_sql_ready()
        self.refresh_connection()
        self.verify_permission_errors()
        after = self.continuity_snapshot()
        check_transition_continuity(before, after)
        self.wait_api_ready()
        self.source_compose = candidate_source
        return {
            "kind": transition,
            "continuity": before,
            "permission_sqlstates": ["42501", "42501"],
        }

    def published_port(self, service, target):
        address = (
            self.compose("port", service, str(target), label="allocated port discovery")
            .decode()
            .strip()
        )
        match = re.fullmatch(r"127\.0\.0\.1:(\d+)", address)
        if not match:
            raise ValueError(
                f"allocated service did not bind exclusively to loopback (Docker reported {address!r})"
            )
        return int(match[1])

    def sql(self, source):
        return self.compose(
            "exec",
            "-T",
            "postgres",
            "psql",
            "-X",
            "-U",
            "supabase_admin",
            "-d",
            "postgres",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            label="disposable SQL probe",
            input=source.encode(),
        ).decode()

    def apply(self, files, cli):
        folder = self.directory / "supabase/migrations"
        folder.mkdir(parents=True, exist_ok=True)
        for path, content in files.items():
            (folder / Path(path).name).write_bytes(content)
        config = self.directory / "supabase/config.toml"
        config.write_text(
            f'project_id = "fork-{self.project[-32:]}"\n[db]\nport = {self.port}\nmajor_version = 15\n'
        )
        manifest = migration_manifest(files)
        before = self.sql(
            "SELECT to_regclass('supabase_migrations.schema_migrations') IS NOT NULL;"
        ).strip()
        if before == "t":
            existing = self.sql(
                "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;"
            ).splitlines()
            if set(existing) - set(manifest):
                raise ValueError(
                    "extra migration found before application; automatic repair is forbidden"
                )
        self.call(
            cli,
            "migration",
            "up",
            "--include-all",
            "--db-url",
            self.db_url,
            label="immutable migrations",
        )
        applied = self.sql(
            "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;"
        ).splitlines()
        check_applied(manifest, applied)
        (self.directory / "migration-provenance.json").write_text(
            json.dumps(manifest, indent=2)
        )

    def fingerprint(self):
        dump = self.compose(
            "exec",
            "-T",
            "postgres",
            "pg_dump",
            "-U",
            "supabase_admin",
            "-d",
            "postgres",
            "--schema-only",
            "--exclude-schema=supabase_migrations",
            "--exclude-schema=fork_verification",
            label="complete schema fingerprint",
        ).decode()
        (self.directory / "schema.sql").write_text(dump)
        return schema_fingerprint(dump)

    def artifacts(self):
        assert_owned(self.project, self.resources())
        for path in ARTIFACTS.values():
            (self.directory / path).parent.mkdir(parents=True, exist_ok=True)
        (self.directory / "packages/database/supabase/functions/lib").mkdir(
            parents=True, exist_ok=True
        )
        # Run the real repository generator from the isolated output directory.
        # The pinned CLI owns/removes its short-lived metadata container.
        config = self.directory / "supabase/config.toml"
        migration_config = config.read_text()
        try:
            # For generation the CLI's "local" mode means its own named
            # container, not a direct connection to our Compose-owned database.
            config.write_text(
                migration_config.replace(f"port = {self.port}", "port = 1")
            )
            self.call(
                self.root / "node_modules/.bin/tsx",
                self.root / "scripts/generate-db-types.ts",
                label="database type generation",
            )
        finally:
            config.write_text(migration_config)
        rest_port = self.published_port("postgrest", 3000)
        self.sql("NOTIFY pgrst, 'reload schema';")
        time.sleep(1)
        request = urllib.request.Request(
            f"http://127.0.0.1:{rest_port}/",
            headers={"Authorization": f"Bearer {self.service_key}"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                swagger = json.load(response)
        except Exception as error:
            raise ValueError("disposable PostgREST schema generation failed") from error
        payload = json.dumps(swagger).encode()

        meta_port = self.published_port("meta", 8080)
        proof_sql = (self.root / "scripts/lib/swagger-partner-alias.sql").read_text()

        def query(body):
            request = urllib.request.Request(
                f"http://127.0.0.1:{meta_port}/query",
                data=body,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)

        server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), studio_schema_adapter(payload, proof_sql, query)
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.env["PORT_STUDIO"] = str(server.server_port)
        try:
            self.call(
                self.root / "node_modules/.bin/tsx",
                self.root / "scripts/generate-swagger-docs.ts",
                label="Swagger schema generation",
            )
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        connection = self.directory / "connection.json"
        connection.write_text(json.dumps({"project": self.project, "url": self.db_url}))
        self.call(
            self.root / "node_modules/.bin/tsx",
            self.root / ".fork/schema-artifacts.ts",
            "backup",
            connection,
            self.directory / ARTIFACTS["backup"],
            label="backup schema generation",
        )
        return {
            kind: self.call(
                self.root / "node_modules/.bin/tsx",
                self.root / ".fork/schema-artifacts.ts",
                "canonical",
                "types" if kind == "function-types" else kind,
                self.directory / path,
                label=f"canonical {kind} schema",
            )
            .decode()
            .strip()
            for kind, path in ARTIFACTS.items()
        }

    def close(self):
        if not self.compose_file.exists():
            return
        assert_owned(self.project, self.resources())
        self.compose(
            "down", "--volumes", "--remove-orphans", label="owned disposable cleanup"
        )
        if self.resources():
            raise ValueError("disposable resource cleanup incomplete")


def interrupted(signum, frame):
    raise SystemExit(128 + signum)


def verify_stack(
    stack, name, stages, cli, transition, candidate_source, check_permissions
):
    """Run the identical owned-stack path for strict checks and local diagnostics."""
    evidence = None
    try:
        stack.start()
        for index, files in enumerate(stages):
            if index == 1 and transition:
                evidence = stack.transition_platform(transition, candidate_source)
            print(
                f"schema verification: {name}, applying {len(files)} immutable migrations",
                flush=True,
            )
            stack.apply(files, cli)
        if check_permissions:
            stack.verify_permission_errors()
        fingerprint = stack.fingerprint()
        generated = stack.artifacts()
        repeated = stack.artifacts()
        if generated != repeated:
            raise ValueError(f"{name} schema artifacts are not repeatable")
        return {"schema": fingerprint, "artifacts": generated}, evidence
    finally:
        stack.close()


def main():
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base", required=True, help="explicit previous-release commit SHA"
    )
    parser.add_argument(
        "--regenerate",
        action="store_true",
        help="generate unverified outputs from working-tree migrations only under .fork/local; never attest or overwrite tracked artifacts",
    )
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    if not re.fullmatch(r"[a-fA-F0-9]{7,40}", args.base):
        raise ValueError("--base must be an explicit commit SHA")
    revision = git(root, "rev-parse", "--verify", "HEAD^{commit}").decode().strip()
    check_artifact_inventory(
        json.loads((root / ".fork/generated-artifacts.json").read_text())
    )
    base_revision = (
        git(root, "rev-parse", "--verify", args.base + "^{commit}").decode().strip()
    )
    check_upgrade_baseline(root, base_revision, revision, regenerate=args.regenerate)
    current_inputs = generation_inputs(root)
    if not args.regenerate:
        check_revision_inputs(root, revision)
    candidate, base = migrations_at(root, revision), migrations_at(root, base_revision)
    if args.regenerate:
        candidate = {
            path.relative_to(root).as_posix(): path.read_bytes()
            for path in (root / MIGRATIONS).glob("*")
            if path.is_file()
        }
    if not candidate:
        raise ValueError("candidate contains no migrations")
    check_history(base, candidate)
    expected_cli = supabase_pin(
        (root / "pnpm-workspace.yaml").read_bytes()
        if args.regenerate
        else git(root, "show", f"{revision}:pnpm-workspace.yaml")
    )
    env = clean_environment()
    endpoint = (
        run(
            ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            cwd=root,
            env=env,
            label="local Docker context",
        )
        .decode()
        .strip()
    )
    if not endpoint.startswith("unix://"):
        raise ValueError(
            "schema verification requires a local Unix-socket Docker context"
        )
    run(["docker", "info"], cwd=root, env=env, label="Docker availability")
    cli = root / "node_modules/.bin/supabase"
    if not cli.exists():
        raise ValueError(
            "pinned local Supabase CLI is missing; install the frozen toolchain"
        )
    version = (
        run([cli, "--version"], cwd=root, env=env, label="pinned Supabase CLI")
        .decode()
        .strip()
    )
    if version != expected_cli:
        raise ValueError(
            "Supabase CLI version differs from the candidate dependency catalog"
        )
    location = root / ".fork/local/schema-runs" / uuid.uuid4().hex
    location.mkdir(parents=True)
    source_compose = location / "source-compose.yml"
    source_compose.write_bytes(
        (root / COMPOSE_INPUT).read_bytes()
        if args.regenerate
        else git(root, "show", f"{revision}:{COMPOSE_INPUT}")
    )
    candidate_bootstrap = (
        (root / BOOTSTRAP_INPUT).read_bytes()
        if args.regenerate
        else git(root, "show", f"{revision}:{BOOTSTRAP_INPUT}")
    )
    base_compose = location / "base-compose.yml"
    base_compose.write_bytes(git(root, "show", f"{base_revision}:{COMPOSE_INPUT}"))
    base_bootstrap = git(root, "show", f"{base_revision}:{BOOTSTRAP_INPUT}")
    report = {
        "candidate": revision,
        "base": base_revision,
        "cli": version,
        "status": "failed",
        "generator_inputs": {
            path: hashlib.sha256(content).hexdigest()
            for path, content in current_inputs.items()
        },
    }
    results = {}
    try:
        # Resolve both definitions in one synthetic environment before stripping
        # production bindings. Otherwise sanitization could hide platform changes.
        resolver = DisposableStack(root, location, source_compose)
        resolved_candidate = resolver.resolved_compose()
        transition = None
        if not args.regenerate:
            transition = resolver.classify_platform(
                base_compose, source_compose, base_bootstrap, candidate_bootstrap
            )
        check_permissions = HINT_ARGUMENT in resolved_candidate["services"][
            "postgres"
        ].get("command", [])
        report["platform_transition"] = transition
        paths = [("fresh", [candidate])]
        if not args.regenerate:
            paths.append(("upgrade", [base, candidate]))
        for name, stages in paths:
            allocation = location / name
            allocation.mkdir()
            (allocation / "init.sql").write_bytes(
                base_bootstrap if name == "upgrade" else candidate_bootstrap
            )
            stack = DisposableStack(
                root, allocation, base_compose if name == "upgrade" else source_compose
            )
            results[name], evidence = verify_stack(
                stack, name, stages, cli, transition, source_compose, check_permissions
            )
            if evidence:
                report["platform_transition_evidence"] = evidence
        if args.regenerate:
            report["status"] = "generated-unverified"
            print(
                "schema artifacts GENERATED/UNVERIFIED under the evidence directory; review/copy/commit the outputs, then run strict verification",
                flush=True,
            )
            return
        if results["fresh"] != results["upgrade"]:
            raise ValueError("fresh and upgrade schema definitions/artifacts differ")
        expected = {}
        for kind, path in ARTIFACTS.items():
            baseline = location / (kind + ".baseline")
            baseline.write_bytes(git(root, "show", f"{revision}:{path}"))
            expected[kind] = (
                run(
                    [
                        "corepack",
                        "pnpm",
                        "exec",
                        "tsx",
                        root / ".fork/schema-artifacts.ts",
                        "canonical",
                        "types" if kind == "function-types" else kind,
                        baseline,
                    ],
                    cwd=root,
                    env=env,
                    label="committed schema artifact",
                )
                .decode()
                .strip()
            )
        stale = [
            kind
            for kind in ARTIFACTS
            if expected[kind] != results["fresh"]["artifacts"][kind]
        ]
        if stale:
            raise ValueError(
                "committed schema artifacts differ from migration-built provenance: "
                + ", ".join(stale)
            )
        check_committed_inputs(current_inputs, generation_inputs(root))
        report.update({"status": "passed", "results": results})
        print(
            "schema verification: fresh, upgrade and committed artifacts agree",
            flush=True,
        )
    finally:
        report["results"] = results
        (location / "report.json").write_text(json.dumps(report, indent=2))
        print(f"schema verification evidence: {location}", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as error:
        print(f"schema verification FAILED: {error}", file=sys.stderr)
        sys.exit(1)
