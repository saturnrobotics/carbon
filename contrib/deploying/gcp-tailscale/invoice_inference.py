"""Optional Google invoice inference configuration; no static credentials."""

import datetime
import math
import re
import subprocess
import time

CONFIG_KEYS = {
    "INVOICE_INTAKE_ENABLED", "INVOICE_AI_PROJECT", "INVOICE_AI_LOCATION", "INVOICE_AI_MODEL",
    "INVOICE_AI_INPUT_PRICE_USD_PER_MILLION", "INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION",
    "INVOICE_AI_PRICE_VERIFIED_AT", "INVOICE_AI_MAX_INPUT_TOKENS", "INVOICE_AI_MAX_OUTPUT_TOKENS",
}


def validate(values, *, project=None):
    selected = {key: values[key] for key in CONFIG_KEYS if key in values}
    if not selected:
        return {"INVOICE_INTAKE_ENABLED": "false"}
    if any(not isinstance(value, str) for value in selected.values()):
        raise ValueError("Invoice inference configuration values must be strings")
    enabled = selected.get("INVOICE_INTAKE_ENABLED", "false")
    if enabled not in ("true", "false"):
        raise ValueError("INVOICE_INTAKE_ENABLED must be true or false")
    selected.setdefault("INVOICE_INTAKE_ENABLED", enabled)
    selected.setdefault("INVOICE_AI_LOCATION", "us")
    selected.setdefault("INVOICE_AI_MODEL", "gemini-3.5-flash")
    selected.setdefault("INVOICE_AI_MAX_INPUT_TOKENS", "32768")
    selected.setdefault("INVOICE_AI_MAX_OUTPUT_TOKENS", "16384")
    if selected["INVOICE_AI_LOCATION"] != "us":
        raise ValueError("Invoice inference requires the explicit US processing endpoint")
    if not re.fullmatch(r"gemini-[a-z0-9.-]{1,80}", selected["INVOICE_AI_MODEL"]):
        raise ValueError("Invalid INVOICE_AI_MODEL")
    for key, maximum in (("INVOICE_AI_MAX_INPUT_TOKENS", 200000), ("INVOICE_AI_MAX_OUTPUT_TOKENS", 65536)):
        if not selected[key].isdigit() or not 0 < int(selected[key]) <= maximum:
            raise ValueError(f"Invalid {key}")
    if "INVOICE_AI_PROJECT" in selected:
        if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", selected["INVOICE_AI_PROJECT"]):
            raise ValueError("Invalid INVOICE_AI_PROJECT")
        if project and selected["INVOICE_AI_PROJECT"] != project:
            raise ValueError("Invoice inference project must match the deployment project")
    for key, maximum in (("INVOICE_AI_INPUT_PRICE_USD_PER_MILLION", 100), ("INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION", 1000)):
        if key in selected:
            try:
                value = float(selected[key])
            except ValueError:
                raise ValueError(f"Invalid {key}") from None
            if not math.isfinite(value) or not 0 < value <= maximum:
                raise ValueError(f"Invalid {key}")
    if "INVOICE_AI_PRICE_VERIFIED_AT" in selected:
        try:
            if datetime.date.fromisoformat(selected["INVOICE_AI_PRICE_VERIFIED_AT"]).isoformat() != selected["INVOICE_AI_PRICE_VERIFIED_AT"]:
                raise ValueError()
        except ValueError:
            raise ValueError("INVOICE_AI_PRICE_VERIFIED_AT must be a valid YYYY-MM-DD date") from None
    if enabled == "true":
        for key in ("INVOICE_AI_PROJECT", "INVOICE_AI_INPUT_PRICE_USD_PER_MILLION", "INVOICE_AI_OUTPUT_PRICE_USD_PER_MILLION", "INVOICE_AI_PRICE_VERIFIED_AT"):
            if not selected.get(key):
                raise ValueError(f"Set {key} before enabling invoice inference")
    return selected


def configuration(base, settings):
    if not isinstance(settings, dict) or set(settings) - CONFIG_KEYS:
        raise ValueError("Unknown invoice inference configuration keys")
    return {**base, **validate(settings, project=base["PROJECT_ID"])}


def configure(config, erp):
    erp["environment"].update(validate(config, project=config.get("PROJECT_ID")))


def provision(cloud):
    config = validate(cloud.c, project=cloud.c["PROJECT_ID"])
    if config["INVOICE_INTAKE_ENABLED"] != "true":
        return
    project, vm, zone = cloud.c["PROJECT_ID"], cloud.c["VM_NAME"], cloud.c["ZONE"]
    account_id = vm[:21] + "-invoice"
    account_email = f"{account_id}@{project}.iam.gserviceaccount.com"
    role_id = vm.replace("-", "_") + "_invoice_inference"
    role_name = f"projects/{project}/roles/{role_id}"
    permissions = ["aiplatform.endpoints.predict"]

    # Validate an existing identity before provisioning or stopping anything.
    instance = cloud.get("compute", "instances", "describe", vm, "--zone", zone)
    accounts = instance.get("serviceAccounts", [])
    if accounts and (len(accounts) != 1 or accounts[0].get("email") != account_email):
        raise ValueError("VM has an unexpected service account; review its purpose before enabling inference")
    cloud.call("services", "enable", "aiplatform.googleapis.com", "iam.googleapis.com")
    roles = cloud.get("iam", "roles", "list")
    existing_role = next((role for role in roles if role.get("name") == role_name), None)
    if existing_role:
        details = cloud.get("iam", "roles", "describe", role_id)
        if details.get("deleted") or details.get("includedPermissions") != permissions:
            raise ValueError("Invoice inference role has unexpected permissions; review IAM before deployment")
    else:
        cloud.call("iam", "roles", "create", role_id, "--title=Carbon invoice inference", "--description=Read-only model inference for document intake", "--permissions=" + ",".join(permissions), "--stage=GA")
    accounts_found = cloud.get("iam", "service-accounts", "list", "--filter", f"email={account_email}")
    if not accounts_found:
        cloud.call("iam", "service-accounts", "create", account_id, "--display-name=Carbon invoice inference")
    policy = cloud.get("projects", "get-iam-policy", project)
    member = "serviceAccount:" + account_email
    grants = [binding for binding in policy.get("bindings", []) if member in binding.get("members", [])]
    if any(binding.get("role") != role_name or binding.get("condition") for binding in grants):
        raise ValueError("Invoice inference service account has unexpected project grants")
    if not grants:
        delays = (2, 4, 8, 16, 30)
        for attempt in range(len(delays) + 1):
            try:
                # Capture policy output and diagnostics; neither belongs in public logs.
                cloud.call("projects", "add-iam-policy-binding", project, "--member=" + member,
                           "--role=" + role_name, "--condition=None", capture=True, capture_error=True)
                break
            except subprocess.CalledProcessError as error:
                diagnostic = error.stderr or ""
                # IAM can briefly reject an identity created by this very run.
                # Permission errors, other identities and existing accounts fail immediately.
                if (accounts_found or attempt == len(delays) or "INVALID_ARGUMENT:" not in diagnostic
                        or not re.search(r"Service account " + re.escape(account_email) + r" does not exist\b", diagnostic)):
                    raise
                time.sleep(delays[attempt])
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
    if accounts and accounts[0].get("scopes") == scopes:
        return
    was_running = instance.get("status") == "RUNNING"
    if instance.get("status") not in ("RUNNING", "TERMINATED"):
        raise ValueError("Wait for the VM to finish changing state before enabling inference")
    if was_running:
        cloud.call("compute", "instances", "stop", vm, "--zone", zone)
    try:
        cloud.call("compute", "instances", "set-service-account", vm, "--zone", zone, "--service-account", account_email, "--scopes=cloud-platform")
    finally:
        if was_running:
            cloud.call("compute", "instances", "start", vm, "--zone", zone)
