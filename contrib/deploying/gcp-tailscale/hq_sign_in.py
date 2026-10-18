"""Optional sign-in through the HQ identity provider, with Google as break-glass.

HQ authenticates people with Google Workspace, applies its own app-entry policy,
and serves a Keycloak-compatible OpenID provider below ``<HQ_ISSUER>/oidc/keycloak``.
GoTrue's built-in Keycloak provider uses it with the authorization-code flow; the
token and userinfo calls go server to server over the tailnet, and the identity
comes only from userinfo. GoTrue records it as ``provider = 'keycloak'``.

HQ's origin is private configuration and the client secret is a deployment
secret mounted only into GoTrue. Google sign-in stays enabled unless
``GOOGLE_SIGN_IN_ENABLED`` is ``"false"``, which requires HQ sign-in, so a
deployment always keeps at least one way in. With HQ disabled the rendered stack
is unchanged.
"""

import re

CONFIG_KEYS = {"HQ_SIGN_IN_ENABLED", "HQ_ISSUER", "GOOGLE_SIGN_IN_ENABLED"}
SECRET_KEYS = {"HQ_OIDC_CARBON_SECRET"}
SECRET_NAME = "hq_oidc_carbon_secret"
CLIENT_ID = "carbon"
KEYCLOAK_PATH = "/oidc/keycloak"
ISSUER = re.compile(r"https://[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}")
MIN_SECRET_LENGTH = 32


def _flag(config, key, default):
    value = config.get(key, default)
    if value not in ("true", "false"):
        raise ValueError(f"{key} must be true or false")
    return value == "true"


def validate(config):
    """Return (hq_enabled, google_enabled). Error messages never echo a value."""
    hq = _flag(config, "HQ_SIGN_IN_ENABLED", "false")
    google = _flag(config, "GOOGLE_SIGN_IN_ENABLED", "true")
    issuer = config.get("HQ_ISSUER", "")
    if not isinstance(issuer, str) or (issuer and not ISSUER.fullmatch(issuer)):
        raise ValueError("Invalid HQ_ISSUER; use the HQ origin, https://<host>, with no path or trailing slash")
    secret = config.get("HQ_OIDC_CARBON_SECRET", "")
    if not isinstance(secret, str) or len(secret) > 4096 or any(ord(c) < 33 or ord(c) == 127 for c in secret):
        raise ValueError("Invalid HQ_OIDC_CARBON_SECRET; use a single-line private value without spaces")
    if secret.startswith("replace-"):
        raise ValueError("HQ_OIDC_CARBON_SECRET is still the example placeholder; supply the secret or remove the key")
    if hq:
        if not issuer:
            raise ValueError("Set HQ_ISSUER before enabling HQ sign-in")
        if len(secret) < MIN_SECRET_LENGTH:
            raise ValueError(f"Supply HQ_OIDC_CARBON_SECRET (at least {MIN_SECRET_LENGTH} characters) before enabling HQ sign-in")
    if not hq and not google:
        raise ValueError("GOOGLE_SIGN_IN_ENABLED=false requires HQ_SIGN_IN_ENABLED=true; keep at least one sign-in method")
    return hq, google


def auth_providers(config):
    """Carbon's AUTH_PROVIDERS for ERP and MES: "google", "hq,google" or "hq"."""
    hq, google = validate(config)
    return ",".join(name for name, enabled in (("hq", hq), ("google", google)) if enabled)


def google_enabled(config):
    return "true" if validate(config)[1] else "false"


def configure(config, auth, directory, write_private):
    """Add the HQ provider to the serving GoTrue only.

    Call this after the bootstrap GoTrue copy is made: bootstrap never enables an
    OAuth provider and never mounts the client secret.
    """
    if not validate(config)[0]:
        return
    path = directory / SECRET_NAME
    # The renderer's writer leaves the file 0444 in the root-only secrets directory.
    write_private(path, config["HQ_OIDC_CARBON_SECRET"])
    auth["secrets"].append(SECRET_NAME)
    auth["environment"].update({
        "GOTRUE_EXTERNAL_KEYCLOAK_ENABLED": "true",
        "GOTRUE_EXTERNAL_KEYCLOAK_CLIENT_ID": CLIENT_ID,
        "GOTRUE_EXTERNAL_KEYCLOAK_SECRET": "__HQ_OIDC_CARBON_SECRET__",
        "GOTRUE_EXTERNAL_KEYCLOAK_URL": config["HQ_ISSUER"] + KEYCLOAK_PATH,
        # Same callback as Google; GoTrue's URI allow list is unchanged.
        "GOTRUE_EXTERNAL_KEYCLOAK_REDIRECT_URI": "https://" + config["SUPABASE_HOST"] + "/auth/v1/callback",
    })
