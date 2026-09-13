"""Execute the actual maintenance registration request against a local HTTP server."""
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import subprocess
import threading
import unittest

HERE = Path(__file__).resolve().parent


class RegistrationProbeTests(unittest.TestCase):
    def test_registration_uses_configured_origin_and_rejects_http_failures(self):
        script = (HERE / "host-deploy.sh").read_text()
        blocks = re.findall(r"node --input-type=module -e '(.*?)'", script, re.S)
        program = next(block for block in blocks if "Inngest app registration failed" in block)
        requests = []

        class RegistrationHandler(BaseHTTPRequestHandler):
            def do_PUT(self):
                requests.append((self.path, self.headers.get("Host")))
                self.send_response(self.server.response_status)
                self.send_header("Location", "/unexpected")
                self.end_headers()
                self.wfile.write(json.dumps({"ok": True}).encode())

            def log_message(self, format, *args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), RegistrationHandler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            host = f"127.0.0.1:{server.server_port}"
            try:
                for status in (200, 500, 302):
                    with self.subTest(status=status):
                        server.response_status = status
                        result = subprocess.run(
                            ["node", "--input-type=module", "-e", program],
                            env={**os.environ, "ERP_URL": "http://" + host},
                            capture_output=True, text=True, timeout=15,
                        )
                        self.assertEqual(result.returncode, 0 if status == 200 else 1,
                                         result.stderr)
            finally:
                server.shutdown()
                thread.join()
        self.assertEqual(requests, [("/api/inngest", host)] * 3)
