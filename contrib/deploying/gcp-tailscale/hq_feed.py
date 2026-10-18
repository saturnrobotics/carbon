#!/usr/bin/env python3
"""Push Carbon's money-free open-record projections and entitlements to HQ.

Contract: .fork/specs/2026-10-18-hq-feed-exporter.md (HQ plan 0006C). A systemd
timer installed by host-deploy.sh runs this on the Carbon host every five
minutes. It reads the database in a single READ ONLY REPEATABLE READ
transaction. Only confirmed sign-in emails come from auth.users through the
admin connection; everything else is read as the service role. It then POSTs one
JSON snapshot with an HS256 bearer token. HQ shows a record only when its own
policy and these entitlements both
allow it, so this file only reads Carbon's permissions; it changes no
authentication or RBAC logic.

Standard library only: the host has python3 but no PostgreSQL driver, so the
read goes through psql inside the deployment's postgres container. Logs carry
counts and the HTTP status, never the token, the key or the body.
"""

import argparse
import base64
import hashlib
import hmac
import json
from pathlib import Path
import re
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

CONFIG_KEYS = {"HQ_INGEST_URL", "HQ_INGEST_EMAIL_DOMAIN"}
SECRET_KEYS = {"HQ_INGEST_CARBON_KEY"}
SECRET_NAME = "hq_ingest_carbon_key"
STATE = Path("/var/lib/carbon")

MAX_BODY_BYTES = 8 * 1024 * 1024
HTTP_TIMEOUT_SECONDS = 30
DATABASE_TIMEOUT_SECONDS = 120
TOKEN_LIFETIME_SECONDS = 60
MIN_KEY_BYTES = 32
ACCEPTED_STATUSES = (200, 204)

URL_PATTERN = re.compile(
    r"https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+"
    r"(?::[0-9]{1,5})?/[A-Za-z0-9._~/-]*"
)
DOMAIN_PATTERN = re.compile(r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}")
DATE_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
TIMESTAMP_PATTERN = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
PERMISSION_PATTERN = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)+")
KEY_PATTERN = re.compile(r"[\x21-\x7e]+")

# No money crosses to HQ. Every emitted key is checked against this pattern
# before sending. The contract's envelope timestamp "generated_at" contains
# "rate" (gene-rate-d); it is the only exemption, and only at the top level.
MONEY_PATTERN = re.compile(r"price|cost|rate|total|currency|tax|amount", re.I)
MONEY_EXEMPT_PATHS = {("generated_at",)}

# The Carbon permissions of which any one lets a person see the row in Carbon.
# Sales and purchase orders mirror Carbon's RLS; jobs are stricter than Carbon,
# whose employees can view every job.
REQUIRES = {
    "sales_orders": ["sales_view", "inventory_view", "invoicing_view"],
    "purchase_orders": ["purchasing_view", "inventory_view", "invoicing_view"],
    "jobs": ["production_view"],
}

# Exact projections in contract order. Anything else the database returns is
# dropped, so a widened query cannot widen the payload.
FIELDS = {
    "companies": ("id", "name"),
    "entitlements": ("email", "scope", "permissions"),
    "sales_orders": ("id", "scope", "readable_id", "status", "customer", "order_date", "promised_date"),
    "purchase_orders": ("id", "scope", "readable_id", "status", "supplier", "order_date", "due_date"),
    "jobs": ("id", "scope", "readable_id", "status", "item", "due_date"),
}
LISTS = tuple(FIELDS)
DATE_FIELDS = {"order_date", "promised_date", "due_date"}
REQUIRED_STRINGS = {"id", "scope", "email"}

DEPLOYMENT_PSQL = (
    "docker", "compose", "--project-name", "carbon", "--file", str(STATE / "runtime/compose.json"),
    "exec", "-T", "postgres", "/usr/local/bin/carbon-secrets-entrypoint.sh",
    "psql", "-h", "127.0.0.1", "-U", "supabase_admin", "-d", "postgres",
)
LOCAL_PSQL = ("psql",)
PSQL_OPTIONS = ("-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1")

# One REPEATABLE READ snapshot: every statement below sees the same data.
PREAMBLE = """\
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '60s';
SET LOCAL lock_timeout = '10s';
"""

# Entitlements are keyed on the sign-in email GoTrue confirmed, never on
# public."user".email, which users may edit themselves. service_role has no
# SELECT on auth.users, so the admin connection reads exactly these two columns
# into a psql variable before narrowing to service_role.
IDENTITIES = """\
SELECT COALESCE(json_object_agg(au."id"::text, lower(au."email")), '{}'::json) AS verified_identities
FROM auth."users" au
WHERE au."email_confirmed_at" IS NOT NULL AND au."email" IS NOT NULL \\gset
"""

# Everything else is read as service_role (no login of its own; the admin
# connection switches to it), so the read has exactly the service role's
# privileges.
NARROW = "SET LOCAL ROLE service_role;\n"

# Columns are named explicitly; no price, cost, rate, total, currency or tax
# column is read. Open-status lists are part of the contract.
SNAPSHOT = """\
SELECT json_build_object(
  'snapshot_time', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  'companies', COALESCE((
    SELECT json_agg(json_build_object('id', c."id", 'name', c."name") ORDER BY c."id")
    FROM public."company" c
  ), '[]'::json),
  'entitlements', COALESCE((
    SELECT json_agg(json_build_object(
      'email', vi."email",
      'scope', m."companyId",
      'permissions', COALESCE((
        SELECT json_agg(p.key ORDER BY p.key)
        FROM jsonb_each(CASE WHEN jsonb_typeof(up."permissions") = 'object'
                             THEN up."permissions" ELSE '{}'::jsonb END) p
        WHERE jsonb_typeof(p.value) = 'array' AND p.value ? m."companyId"
      ), '[]'::json)
    ) ORDER BY vi."email", m."companyId")
    FROM public."userToCompany" m
    JOIN public."user" u ON u."id" = m."userId"
    JOIN public."employee" e ON e."id" = m."userId" AND e."companyId" = m."companyId"
    JOIN jsonb_each_text(:'verified_identities'::jsonb) vi("id", "email") ON vi."id" = u."id"
    LEFT JOIN public."userPermission" up ON up."id" = m."userId"
    WHERE m."role"::text = 'employee'
      AND u."active" IS TRUE
      AND e."active" IS TRUE
      AND lower(u."email") = vi."email"
      AND split_part(vi."email", '@', 2) = :'email_domain'
  ), '[]'::json),
  -- Employees whose editable profile email disagrees with their confirmed
  -- sign-in email get no entitlements; only their number leaves the database.
  'email_mismatches', (
    SELECT count(DISTINCT u."id")
    FROM public."userToCompany" m
    JOIN public."user" u ON u."id" = m."userId"
    JOIN public."employee" e ON e."id" = m."userId" AND e."companyId" = m."companyId"
    JOIN jsonb_each_text(:'verified_identities'::jsonb) vi("id", "email") ON vi."id" = u."id"
    WHERE m."role"::text = 'employee'
      AND u."active" IS TRUE
      AND e."active" IS TRUE
      AND lower(u."email") IS DISTINCT FROM vi."email"
  ),
  'sales_orders', COALESCE((
    SELECT json_agg(json_build_object(
      'id', so."id",
      'scope', so."companyId",
      'readable_id', so."salesOrderId",
      'status', so."status",
      'customer', cu."name",
      'order_date', to_char(so."orderDate", 'YYYY-MM-DD'),
      'promised_date', to_char((
        SELECT min(sol."promisedDate") FROM public."salesOrderLine" sol
        WHERE sol."salesOrderId" = so."id" AND sol."companyId" = so."companyId"
      ), 'YYYY-MM-DD')
    ) ORDER BY so."companyId", so."id")
    FROM public."salesOrder" so
    LEFT JOIN public."customer" cu ON cu."id" = so."customerId" AND cu."companyId" = so."companyId"
    WHERE so."status"::text NOT IN ('Completed', 'Invoiced', 'Cancelled', 'Closed')
  ), '[]'::json),
  'purchase_orders', COALESCE((
    SELECT json_agg(json_build_object(
      'id', po."id",
      'scope', po."companyId",
      'readable_id', po."purchaseOrderId",
      'status', po."status",
      'supplier', su."name",
      'order_date', to_char(po."orderDate", 'YYYY-MM-DD'),
      'due_date', to_char((
        SELECT min(COALESCE(pol."promisedDate", pol."requiredDate")) FROM public."purchaseOrderLine" pol
        WHERE pol."purchaseOrderId" = po."id" AND pol."companyId" = po."companyId"
      ), 'YYYY-MM-DD')
    ) ORDER BY po."companyId", po."id")
    FROM public."purchaseOrder" po
    LEFT JOIN public."supplier" su ON su."id" = po."supplierId" AND su."companyId" = po."companyId"
    WHERE po."status"::text NOT IN ('Completed', 'Closed', 'Rejected')
  ), '[]'::json),
  'jobs', COALESCE((
    SELECT json_agg(json_build_object(
      'id', j."id",
      'scope', j."companyId",
      'readable_id', j."jobId",
      'status', j."status",
      'item', COALESCE(i."readableIdWithRevision", i."readableId", i."name"),
      'due_date', to_char(j."dueDate", 'YYYY-MM-DD')
    ) ORDER BY j."companyId", j."id")
    FROM public."job" j
    LEFT JOIN public."item" i ON i."id" = j."itemId" AND i."companyId" = j."companyId"
    WHERE j."status"::text IN ('Draft', 'Planned', 'Ready', 'In Progress', 'Paused')
  ), '[]'::json)
);
"""

QUERY = PREAMBLE + IDENTITIES + NARROW + SNAPSHOT + "COMMIT;\n"


class FeedError(ValueError):
    """A failure whose message is safe to log: no token, key, body or row data."""


def log(message):
    print("hq-feed: " + message, file=sys.stderr, flush=True)


# --- Private configuration (deploy.py, render.py and the timer) -------------

def check_key(key):
    if not isinstance(key, str) or not KEY_PATTERN.fullmatch(key) or len(key.encode()) < MIN_KEY_BYTES:
        raise ValueError(f"HQ_INGEST_CARBON_KEY must be one line of at least {MIN_KEY_BYTES} printable "
                         "non-space ASCII bytes, such as the output of openssl rand -hex 32")


def validate(config):
    """Fail closed on malformed inputs; error messages never echo the key."""
    url = config.get("HQ_INGEST_URL", "")
    if not isinstance(url, str) or (url and not URL_PATTERN.fullmatch(url)):
        raise ValueError("Invalid HQ_INGEST_URL; use the HTTPS ingest URL HQ publishes, "
                         "without credentials, query or fragment")
    domain = config.get("HQ_INGEST_EMAIL_DOMAIN", "")
    if not isinstance(domain, str) or (domain and not DOMAIN_PATTERN.fullmatch(domain)):
        raise ValueError("Invalid HQ_INGEST_EMAIL_DOMAIN; use a lower-case email domain")
    key = config.get("HQ_INGEST_CARBON_KEY", "")
    if not isinstance(key, str):
        raise ValueError("HQ_INGEST_CARBON_KEY must be a string")
    if not key:
        return
    if key.startswith("replace-"):
        raise ValueError("HQ_INGEST_CARBON_KEY is still the example placeholder; supply the key or remove it")
    if not url:
        raise ValueError("Set HQ_INGEST_URL before configuring HQ_INGEST_CARBON_KEY")
    check_key(key)


def enabled(config):
    """The push runs only when both the URL and the shared key are configured."""
    return bool(config.get("HQ_INGEST_URL")) and bool(config.get("HQ_INGEST_CARBON_KEY"))


def email_domain(config):
    """Only this domain's users are exported; it defaults to the login domain."""
    domain = config.get("HQ_INGEST_EMAIL_DOMAIN") or config.get("AUTH_ALLOWED_GOOGLE_DOMAIN", "")
    if not isinstance(domain, str) or not DOMAIN_PATTERN.fullmatch(domain):
        raise FeedError("No valid entitlement email domain; set AUTH_ALLOWED_GOOGLE_DOMAIN or HQ_INGEST_EMAIL_DOMAIN")
    return domain


def store_secret(config, directory, write_private):
    """Called from render.initialize_secrets on the host, never during previews."""
    validate(config)
    path = directory / SECRET_NAME
    if enabled(config):
        write_private(path, config["HQ_INGEST_CARBON_KEY"])
        # Host-only: the root timer reads it; no container mounts it.
        path.chmod(0o400)
    elif path.exists():
        # Removing the key from private configuration disables the push; an old
        # key file must not outlive it.
        path.unlink()


def read_key(path):
    try:
        key = path.read_text().strip()
    except FileNotFoundError:
        raise FeedError("HQ ingest key is missing from the secret store; deploy with HQ_INGEST_CARBON_KEY set") from None
    try:
        check_key(key)
    except ValueError as error:
        raise FeedError(str(error)) from None
    return key


def load_config(path):
    try:
        value = json.loads(path.read_text())
    except FileNotFoundError:
        raise FeedError("Private configuration is missing") from None
    except ValueError:
        raise FeedError("Private configuration is not valid JSON") from None
    if not isinstance(value, dict):
        raise FeedError("Private configuration must be a JSON object")
    return value


# --- Snapshot ----------------------------------------------------------------

def read_database(domain, psql=DEPLOYMENT_PSQL, *, show_errors=False):
    """Run QUERY through psql and return its single JSON row."""
    if not DOMAIN_PATTERN.fullmatch(domain):
        raise FeedError("Invalid entitlement email domain")
    try:
        result = subprocess.run(
            [*psql, *PSQL_OPTIONS, "-v", "email_domain=" + domain, "-f", "-"],
            input=QUERY, capture_output=True, text=True, timeout=DATABASE_TIMEOUT_SECONDS, check=False,
        )
    except subprocess.TimeoutExpired:
        raise FeedError("Database read timed out") from None
    except OSError as error:
        raise FeedError("Database read could not start: " + type(error).__name__) from None
    # Diagnostics only reach an interactive dry run, never the timer's journal.
    if show_errors and result.stderr:
        sys.stderr.write(result.stderr)
    if result.returncode:
        raise FeedError(f"Database read failed (psql exit {result.returncode})")
    try:
        return json.loads(result.stdout)
    except ValueError:
        raise FeedError("Database read returned no JSON snapshot") from None


def _text(value, field, *, required):
    if value is None and not required:
        return None
    if not isinstance(value, str) or (required and not value):
        raise FeedError(f"Unexpected database value type for {field}")
    return value


def _row(kind, row, domain):
    if not isinstance(row, dict):
        raise FeedError(f"Unexpected database row shape in {kind}")
    try:
        projected = {field: row[field] for field in FIELDS[kind]}
    except KeyError:
        raise FeedError(f"Unexpected database row shape in {kind}") from None
    for field, value in projected.items():
        if field == "permissions":
            if not isinstance(value, list) or not all(isinstance(p, str) and PERMISSION_PATTERN.fullmatch(p) for p in value):
                raise FeedError("Unexpected permission list in entitlements")
            projected[field] = sorted(set(value))
        elif field in DATE_FIELDS:
            if value is not None and not (isinstance(value, str) and DATE_PATTERN.fullmatch(value)):
                raise FeedError(f"Unexpected date format for {field}")
        else:
            projected[field] = _text(value, field, required=field in REQUIRED_STRINGS or kind == "companies")
    if kind == "entitlements":
        email = projected["email"].lower()
        # The query already filters on the domain; this is defence in depth.
        if not re.fullmatch(r"[^@\s]+@" + re.escape(domain), email):
            return None
        projected["email"] = email
    if kind in REQUIRES:
        projected["requires"] = list(REQUIRES[kind])
    return projected


def build_payload(snapshot, domain):
    """Project the database snapshot onto exactly the contract's fields."""
    if not isinstance(snapshot, dict) or set(snapshot) != {"snapshot_time", "email_mismatches", *LISTS}:
        raise FeedError("Unexpected database snapshot shape")
    mismatches = snapshot["email_mismatches"]
    if not isinstance(mismatches, int) or isinstance(mismatches, bool) or mismatches < 0:
        raise FeedError("Unexpected email mismatch count")
    if mismatches:
        log(f"dropped entitlements for {mismatches} employee(s) whose profile email differs "
            "from their confirmed sign-in email")
    generated_at = snapshot["snapshot_time"]
    if not isinstance(generated_at, str) or not TIMESTAMP_PATTERN.fullmatch(generated_at):
        raise FeedError("Unexpected snapshot time format")
    payload = {"schema": 1, "source": "carbon", "generated_at": generated_at}
    for kind in LISTS:
        rows = snapshot[kind]
        if not isinstance(rows, list):
            raise FeedError(f"Unexpected database list for {kind}")
        payload[kind] = [projected for projected in (_row(kind, row, domain) for row in rows) if projected]
    # Two users whose emails differ only by case would merge into one HQ
    # identity. Grant neither rather than guess: fewer rows, never more.
    seen, ambiguous = set(), set()
    for row in payload["entitlements"]:
        pair = (row["email"], row["scope"])
        (ambiguous if pair in seen else seen).add(pair)
    if ambiguous:
        payload["entitlements"] = [r for r in payload["entitlements"] if (r["email"], r["scope"]) not in ambiguous]
        log(f"dropped entitlements for {len(ambiguous)} ambiguous email and company pair(s)")
    assert_money_free(payload)
    return payload


def money_keys(value, path=()):
    """Every key path whose name looks like money, apart from the exemption."""
    found = []
    if isinstance(value, dict):
        for key, item in value.items():
            here = path + (key,)
            if MONEY_PATTERN.search(key) and here not in MONEY_EXEMPT_PATHS:
                found.append(".".join(here))
            found.extend(money_keys(item, here))
    elif isinstance(value, list):
        for item in value:
            found.extend(money_keys(item, path + ("[]",)))
    return found


def assert_money_free(payload):
    found = money_keys(payload)
    if found:
        raise FeedError("Refusing to emit money-like keys: " + ", ".join(sorted(set(found))))


def encode(payload):
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_BODY_BYTES:
        raise FeedError(f"Payload is {len(body)} bytes, above the {MAX_BODY_BYTES}-byte limit; nothing was sent")
    return body


def counts(payload):
    return " ".join(f"{kind}={len(payload[kind])}" for kind in LISTS)


# --- Transport -----------------------------------------------------------------

def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _compact(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode()


def token(body, key, *, now, jti):
    """HS256 JWT binding this exact body; HQ verifies it with the same key bytes."""
    claims = {
        "iss": "carbon", "aud": "hq-ingest", "iat": now, "exp": now + TOKEN_LIFETIME_SECONDS,
        "jti": jti, "body_sha256": hashlib.sha256(body).hexdigest(),
    }
    signing_input = _b64(_compact({"alg": "HS256", "typ": "JWT"})) + "." + _b64(_compact(claims))
    signature = hmac.new(key.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return signing_input + "." + _b64(signature)


class _RefuseRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A redirect is a failed push; never forward the bearer token elsewhere.
        return None


def opener():
    # No environment proxies and verified TLS with the system trust store.
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()),
        _RefuseRedirect(),
    )


def send(url, body, key, *, now=None, jti=None, open_url=None):
    """POST the body and return the HTTP status; the response body is ignored."""
    now = int(time.time()) if now is None else now
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token(body, key, now=now, jti=jti or str(uuid.uuid4())),
        "User-Agent": "carbon-hq-feed/1",
    })
    open_url = open_url or opener().open
    try:
        with open_url(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return response.status
    except urllib.error.HTTPError as error:
        error.close()
        return error.code


def describe(error):
    """Name the failure without its message, which can carry the private host."""
    if isinstance(error, urllib.error.URLError) and not isinstance(error.reason, str):
        return "URLError(" + type(error.reason).__name__ + ")"
    return type(error).__name__


# --- Command line ----------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="print the payload to stdout and send nothing")
    parser.add_argument("--config", type=Path, default=STATE / "config.json", help="private deployment configuration")
    parser.add_argument("--local-psql", action="store_true",
                        help="dry runs only: read with the psql on PATH and the standard PG* environment "
                             "(a local development database) instead of the deployment's postgres container")
    parser.add_argument("--email-domain", help="dry runs only: entitlement email domain to use")
    args = parser.parse_args(argv)
    if (args.local_psql or args.email_domain) and not args.dry_run:
        parser.error("--local-psql and --email-domain require --dry-run")
    try:
        config = load_config(args.config) if (not args.dry_run or args.config.exists()) else {}
        validate(config)
        domain = args.email_domain or email_domain(config)
        key = None
        if not args.dry_run:
            if not enabled(config):
                raise FeedError("HQ feed is not configured; set HQ_INGEST_URL and HQ_INGEST_CARBON_KEY")
            key = read_key(STATE / "secrets" / SECRET_NAME)
        snapshot = read_database(domain, LOCAL_PSQL if args.local_psql else DEPLOYMENT_PSQL, show_errors=args.dry_run)
        payload = build_payload(snapshot, domain)
        body = encode(payload)
        if args.dry_run:
            sys.stdout.buffer.write(body + b"\n")
            sys.stdout.flush()
            log(f"dry run, nothing sent: {counts(payload)} bytes={len(body)}")
            return 0
        status = send(config["HQ_INGEST_URL"], body, key)
    except ValueError as error:
        log(str(error))
        return 1
    except (OSError, urllib.error.URLError) as error:
        log("failed: " + describe(error))
        return 1
    if status not in ACCEPTED_STATUSES:
        log(f"push rejected: {counts(payload)} status={status}")
        return 1
    log(f"pushed {counts(payload)} bytes={len(body)} status={status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
