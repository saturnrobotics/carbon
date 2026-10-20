"""Optional: Kong requires HQ's ``authz_api`` claim on Supabase's API routes.

HQ plan 0006B (B8). Once Carbon's permissions are managed by HQ's authz service
(``carbon_private.authz_projection.enabled``), GoTrue's access-token hook puts a
top-level ``authz_api`` claim in every token: the ``api:`` resources authz grants
the person, never anything from user metadata. With ``AUTHZ_API_CLAIM_REQUIRED``
set to ``"true"``, Kong then refuses a token that lacks the resource its route
needs:

- ``/rest/v1/`` (PostgREST) needs ``api:supabase.rest``;
- ``/storage/v1/`` (Storage) needs ``api:supabase.storage``;
- ``/realtime/v1/`` (Realtime, socket and REST) needs ``api:supabase.realtime``;
- ``/functions/v1/`` (the edge runtime) needs ``api:supabase.functions``.

GoTrue's routes (``/auth/v1/`` and ``/verify``) stay open because they issue and
refresh the tokens; the hook refuses a person authz does not know or has
disabled there. The check applies to the tokens GoTrue issues (they always carry
``session_id``). anon and service_role tokens keep today's routes (0006B Q5), and
so do the five-minute user-scoped tokens Carbon's server signs itself with the
JWT secret (``getUserScopedClient``: MCP, ``/api/v1`` workforce calls, download
links, workflows and Inngest dispatch), which carry no ``session_id`` and never
leave that server; RLS still applies to them.
Routes are classified by the upstream they forward to, and rendering refuses a
gateway service whose upstream is not classified, so a new upstream route cannot
bypass the check.

The check is a sandboxed ``pre-function`` (bundled with Kong) running
``auth/kong-authz-api.lua``. It needs Kong's ``cjson.safe`` module, allowed in
the sandbox by name. Kong holds no secret: the upstreams verify signatures.

The switch requires HQ sign-in, and the projection must have been on for at
least one access-token lifetime: Kong cannot read the database row, and a token
issued before it carries no claim, so turning this on first would refuse every
signed-in browser request. Off (the default), the rendered stack is unchanged.
"""

import json
import re
import urllib.parse

import hq_sign_in

CONFIG_KEYS = {"AUTHZ_API_CLAIM_REQUIRED"}
SOURCE = "contrib/deploying/gcp-tailscale/auth/kong-authz-api.lua"
PLUGIN = "pre-function"
# Upstream host -> the api: resource its routes require. GoTrue is open.
OPEN = {"gotrue"}
GATED = {
    "postgrest": "api:supabase.rest",
    "storage": "api:supabase.storage",
    "realtime": "api:supabase.realtime",
    "realtime-dev": "api:supabase.realtime",
    "edge-runtime": "api:supabase.functions",
}
SANDBOX_REQUIRES = "cjson.safe"


def enabled(config):
    value = config.get("AUTHZ_API_CLAIM_REQUIRED", "false")
    if value not in ("true", "false"):
        raise ValueError("AUTHZ_API_CLAIM_REQUIRED must be true or false")
    return value == "true"


def validate(config):
    required = enabled(config)
    if required and not hq_sign_in.validate(config)[0]:
        raise ValueError("AUTHZ_API_CLAIM_REQUIRED=true requires HQ_SIGN_IN_ENABLED=true")
    return required


def function(resource, source):
    """The pre-function body for one gated upstream."""
    if not re.fullmatch(r"api:supabase\.[a-z]+", resource):
        raise ValueError("Invalid api: resource for the gateway")
    return "local REQUIRED = " + json.dumps(resource) + "\n" + source


def configure(config, gateway, kong, repo):
    """Add the claim check to the gateway and enable its plugin; off, change nothing."""
    if not validate(config):
        return
    source = (repo / SOURCE).read_text()
    for plugin in gateway.get("plugins", []):
        if plugin.get("name") == PLUGIN:
            raise ValueError(f"The gateway already configures {PLUGIN}; it would bypass the authz_api check")
    for service in gateway["services"]:
        name = service.get("name", "")
        host = urllib.parse.urlsplit(service.get("url", "")).hostname
        plugins = service.get("plugins", []) + [p for route in service.get("routes", []) for p in route.get("plugins", [])]
        if any(plugin.get("name") == PLUGIN for plugin in plugins):
            raise ValueError(f"Gateway service {name} already configures {PLUGIN}; it would bypass the authz_api check")
        if host in OPEN:
            continue
        if host not in GATED:
            raise ValueError(f"Gateway service {name} forwards to an upstream with no authz_api rule; classify it in authz_api_claim.py")
        service["plugins"] = service.get("plugins", []) + [
            {"name": PLUGIN, "config": {"access": [function(GATED[host], source)]}}]
    environment = kong["environment"]
    environment["KONG_PLUGINS"] += "," + PLUGIN
    environment["KONG_UNTRUSTED_LUA"] = "sandbox"
    environment["KONG_UNTRUSTED_LUA_SANDBOX_REQUIRES"] = SANDBOX_REQUIRES
