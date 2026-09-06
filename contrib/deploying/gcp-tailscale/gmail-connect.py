#!/usr/bin/env python3
"""Authorize one read-only Gmail mailbox and save it in ignored deployment secrets."""

import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

from deploy import HERE, private_json

SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
CALLBACK = "http://127.0.0.1:8765/oauth/callback"


def request_json(url, *, form=None, token=None):
    body = urllib.parse.urlencode(form).encode() if form is not None else None
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, body, headers), timeout=30) as response:
            return json.loads(response.read(1_000_001))
    except urllib.error.HTTPError as exc:
        raise ValueError(f"Google authorization request failed (HTTP {exc.code}); check the OAuth audience, Gmail API, and account consent") from None
    except (OSError, ValueError):
        raise ValueError("Google authorization request failed; check your connection and retry") from None


def authorize(client, email, *, open_browser=webbrowser.open):
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    result = {}

    class CallbackHandler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # The callback query contains a one-time authorization code.

        def do_GET(self):
            parsed = urllib.parse.urlsplit(self.path)
            query = urllib.parse.parse_qs(parsed.query)
            if parsed.path != "/oauth/callback" or not secrets.compare_digest(query.get("state", [""])[0], state):
                self.send_error(400, "Invalid authorization callback")
                return
            if "code" in query:
                result["code"] = query["code"][0]
                message = b"Authorization received. Return to your terminal."
            else:
                result["error"] = True
                message = b"Authorization was declined. Return to your terminal."
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(message)))
            self.end_headers()
            self.wfile.write(message)

    parameters = {
        "client_id": client["client_id"], "redirect_uri": CALLBACK,
        "response_type": "code", "scope": SCOPE, "access_type": "offline",
        "prompt": "consent select_account", "login_hint": email, "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
    }
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(parameters)
    with HTTPServer(("127.0.0.1", 8765), CallbackHandler) as server:
        server.timeout = 1
        print("Opening Google sign-in. Choose the requested mailbox and allow read-only Gmail access.")
        if not open_browser(url):
            raise ValueError("Could not open a browser; run this command in a laptop desktop session")
        deadline = time.monotonic() + 600
        while not result and time.monotonic() < deadline:
            server.handle_request()
    if not result.get("code"):
        raise ValueError("Gmail authorization was declined or timed out")
    token = request_json("https://oauth2.googleapis.com/token", form={
        "client_id": client["client_id"], "client_secret": client["client_secret"],
        "grant_type": "authorization_code", "redirect_uri": CALLBACK,
        "code": result["code"], "code_verifier": verifier,
    })
    if SCOPE not in token.get("scope", "").split() or not token.get("refresh_token") or not token.get("access_token"):
        raise ValueError("Google did not grant read-only offline Gmail access; retry and approve the Gmail scope")
    profile = request_json("https://gmail.googleapis.com/gmail/v1/users/me/profile", token=token["access_token"])
    if profile.get("emailAddress", "").lower() != email.lower():
        raise ValueError("The authorized Gmail mailbox does not match --email; retry with the correct account")
    return {
        "email": profile["emailAddress"].lower(), "clientId": client["client_id"],
        "clientSecret": client["client_secret"], "refreshToken": token["refresh_token"], "enabled": True,
    }


def save_account(path, values, account):
    accounts = json.loads(values.get("GMAIL_ACCOUNTS_JSON") or "[]")
    accounts = [a for a in accounts if a["email"].lower() != account["email"].lower()]
    accounts.append(account)
    if len(accounts) > 10:
        raise ValueError("At most ten Gmail accounts can be configured")
    values["GMAIL_ACCOUNTS_JSON"] = json.dumps(accounts, separators=(",", ":"))
    temporary = path.with_name(path.name + "." + secrets.token_hex(6) + ".tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as output:
            output.write(json.dumps(values, indent=2) + "\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client", required=True, type=Path, help="Private OAuth client JSON downloaded from Google Cloud")
    parser.add_argument("--email", required=True, help="Gmail mailbox to authorize")
    parser.add_argument("--secrets", type=Path, default=HERE / ".local/secrets.json")
    args = parser.parse_args()
    downloaded = private_json(args.client)
    client = downloaded.get("installed") or downloaded.get("web")
    if not isinstance(client, dict) or not all(isinstance(client.get(k), str) and client[k] for k in ("client_id", "client_secret")):
        raise ValueError("Download an OAuth Desktop app or Web application client JSON from Google Cloud")
    if "web" in downloaded and CALLBACK not in client.get("redirect_uris", []):
        raise ValueError("Add " + CALLBACK + " as an authorized redirect URI, then download the client JSON again")
    path = args.secrets.expanduser().resolve()
    values = private_json(path)
    account = authorize(client, args.email)
    save_account(path, values, account)
    print("Gmail connection saved privately. Run make deploy to deliver it to the server.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        # These are our sanitized errors. Never echo provider response bodies,
        # credentials, callback URLs, or local configuration contents.
        sys.exit(str(exc) if isinstance(exc, ValueError) else "Unable to authorize Gmail or write private configuration; check file permissions and port 8765")
