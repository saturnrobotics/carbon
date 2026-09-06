"""Optional, private credentials for the community payment import job."""

import json
import re

CONFIG_KEYS = {"PAYMENT_SYNC_COMPANY_ID"}
SECRET_KEYS = {"MERCURY_API_TOKEN", "GMAIL_ACCOUNTS_JSON"}


def validate(config):
    company = config.get("PAYMENT_SYNC_COMPANY_ID", "")
    if not isinstance(company, str) or (company and not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", company)):
        raise ValueError("Invalid PAYMENT_SYNC_COMPANY_ID")
    for key in SECRET_KEYS:
        value = config.get(key, "")
        if not isinstance(value, str) or len(value) > 100_000 or any(ord(c) < 32 for c in value):
            raise ValueError(f"Invalid {key}; use a single-line private value")
        if value and not company:
            raise ValueError("Set PAYMENT_SYNC_COMPANY_ID before configuring payment sync credentials")
    try:
        accounts = json.loads(config.get("GMAIL_ACCOUNTS_JSON") or "[]")
    except (ValueError, TypeError):
        raise ValueError("GMAIL_ACCOUNTS_JSON must contain a JSON array") from None
    if not isinstance(accounts, list) or len(accounts) > 10:
        raise ValueError("Configure at most ten Gmail mailboxes")
    seen = set()
    for account in accounts:
        if not isinstance(account, dict) or set(account) - {"email", "clientId", "clientSecret", "refreshToken", "enabled"}:
            raise ValueError("Invalid Gmail mailbox configuration")
        if any(not isinstance(account.get(k), str) or not account[k] for k in ("email", "clientId", "clientSecret", "refreshToken")):
            raise ValueError("Gmail mailboxes need email, clientId, clientSecret, and refreshToken")
        email = account["email"].lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or email in seen:
            raise ValueError("Gmail mailbox addresses must be valid and unique")
        if "enabled" in account and type(account["enabled"]) is not bool:
            raise ValueError("Gmail enabled must be a boolean")
        if any(any(ord(c) < 32 for c in account[k]) for k in ("email", "clientId", "clientSecret", "refreshToken")):
            raise ValueError("Gmail credential values cannot contain control characters")
        seen.add(email)


def configure(config, erp, directory, write_private):
    validate(config)
    erp["environment"]["PAYMENT_SYNC_COMPANY_ID"] = config.get("PAYMENT_SYNC_COMPANY_ID", "")
    for key in sorted(SECRET_KEYS):
        value = config.get(key, "")
        if value:
            name = key.lower()
            path = directory / name
            write_private(path, value)
            # Only ERP receives the mount; the host parent directory is root-only.
            path.chmod(0o444)
            erp["secrets"].append(name)
            erp["environment"][key] = f"__{key}__"
        else:
            # Removing a credential from config must not resurrect an old file.
            erp["environment"][key] = ""
