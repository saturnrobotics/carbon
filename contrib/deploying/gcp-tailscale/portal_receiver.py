"""Optional trusted-caller registry for the ERP portal (workforce) receiver.

The ERP API accepts delegated workforce requests only from the service accounts
named in a trusted-caller registry. That registry names service-account subjects
and IAP audiences, so it is a secret. The receiver audience is ordinary
configuration: the reviewable statement of which token audience ERP accepts.
Both values reach only the ERP container; MES never receives them.
"""

import json
import re

CONFIG_KEYS = {"PORTAL_RECEIVER_AUDIENCE"}
SECRET_KEYS = {"PORTAL_TRUSTED_CALLERS_JSON"}
SECRET_NAME = "portal_trusted_callers_json"
MAX_VALUE_LENGTH = 2048
CALLER_KEYS = {"callerId", "serviceAccountSubject", "sourceIapAudience", "operations", "capabilities", "requiredAccessLevels"}


def _bounded_string(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= MAX_VALUE_LENGTH


def _bounded_list(value, minimum, maximum):
    return isinstance(value, list) and minimum <= len(value) <= maximum and all(_bounded_string(item) for item in value)


def _validate_registry(registry):
    """Mirror callers.schema.json; error messages never echo the registry contents."""
    if not isinstance(registry, dict) or set(registry) != {"version", "receiver", "callers"} or registry["version"] != 1:
        raise ValueError("PORTAL_TRUSTED_CALLERS_JSON must be a version 1 registry with receiver and callers")
    receiver = registry["receiver"]
    if not isinstance(receiver, dict) or set(receiver) != {"id", "audience"} or not all(_bounded_string(receiver[key]) for key in ("id", "audience")):
        raise ValueError("PORTAL_TRUSTED_CALLERS_JSON receiver needs an id and an audience")
    callers = registry["callers"]
    if not isinstance(callers, list) or not 1 <= len(callers) <= 100:
        raise ValueError("PORTAL_TRUSTED_CALLERS_JSON needs between one and one hundred callers")
    subjects = set()
    for caller in callers:
        if not isinstance(caller, dict) or set(caller) != CALLER_KEYS:
            raise ValueError("Each trusted caller needs exactly the keys listed in callers.schema.json")
        if not all(_bounded_string(caller[key]) for key in ("callerId", "serviceAccountSubject", "sourceIapAudience")):
            raise ValueError("Trusted caller identifiers must be non-empty strings")
        if not _bounded_list(caller["operations"], 1, 100) or not _bounded_list(caller["capabilities"], 0, 100) or not _bounded_list(caller["requiredAccessLevels"], 0, 20):
            raise ValueError("Trusted caller operations, capabilities and access levels must be bounded string lists")
        if caller["serviceAccountSubject"] in subjects:
            raise ValueError("Trusted caller service-account subjects must be unique")
        subjects.add(caller["serviceAccountSubject"])
    return receiver["audience"]


def validate(config):
    if {"KNOWLEDGE_RECEIVER_AUDIENCE", "KNOWLEDGE_TRUSTED_CALLERS_JSON"} & set(config):
        raise ValueError("Replace legacy receiver configuration with Portal keys before rendering")
    audience = config.get("PORTAL_RECEIVER_AUDIENCE", "")
    if not isinstance(audience, str) or (audience and not re.fullmatch(r"https://[a-z0-9]+(?:[.-][a-z0-9]+)*(?:/[A-Za-z0-9._~/-]*)?", audience)):
        raise ValueError("Invalid PORTAL_RECEIVER_AUDIENCE; use the HTTPS URL callers mint their service tokens for")
    registry = config.get("PORTAL_TRUSTED_CALLERS_JSON", "")
    if not isinstance(registry, str) or len(registry) > 100_000 or any(ord(c) < 32 for c in registry):
        raise ValueError("Invalid PORTAL_TRUSTED_CALLERS_JSON; use a single-line private JSON value")
    if not registry:
        return
    if registry.startswith("replace-"):
        raise ValueError("PORTAL_TRUSTED_CALLERS_JSON is still the example placeholder; supply the registry or remove the key")
    if not audience:
        raise ValueError("Set PORTAL_RECEIVER_AUDIENCE before configuring PORTAL_TRUSTED_CALLERS_JSON")
    try:
        parsed = json.loads(registry)
    except ValueError:
        raise ValueError("PORTAL_TRUSTED_CALLERS_JSON must contain a JSON object") from None
    if _validate_registry(parsed) != audience:
        raise ValueError("PORTAL_RECEIVER_AUDIENCE must equal the registry's receiver audience")


def configure(config, erp, directory, write_private, *, materialize=True):
    validate(config)
    erp["environment"]["PORTAL_RECEIVER_AUDIENCE"] = config.get("PORTAL_RECEIVER_AUDIENCE", "")
    registry = config.get("PORTAL_TRUSTED_CALLERS_JSON", "")
    if registry:
        path = directory / SECRET_NAME
        write_private(path, registry)
        # Only ERP receives the mount; the host parent directory is root-only.
        if materialize:
            path.chmod(0o444)
        erp["secrets"].append(SECRET_NAME)
        erp["environment"]["PORTAL_TRUSTED_CALLERS_JSON"] = "__PORTAL_TRUSTED_CALLERS_JSON__"
    else:
        # Removing the registry must not resurrect an old file: an empty value
        # leaves the receiver refusing every workforce request.
        erp["environment"]["PORTAL_TRUSTED_CALLERS_JSON"] = ""
