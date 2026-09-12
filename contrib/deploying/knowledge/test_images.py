"""Contracts for the local manual-v1 OCI images and parser test adapter."""

from http.client import HTTPConnection
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
UNITS = ("web", "query", "ingest", "parser", "schema", "retention")
DRIVE_VARIABLE = "KNOWLEDGE_DRIVE_ENABLED"


def dockerfile_stages(text):
    """Split a Dockerfile into its named build stages.

    Text searches cannot answer "does the release image build receive this
    argument" — the file holds several images and only one of them is shipped.
    Line continuations are joined so an instruction is one entry.
    """
    joined = text.replace("\\\n", " ")
    stages = {}
    current = None
    for line in joined.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        words = stripped.split()
        if words[0].upper() == "FROM":
            base = words[1]
            name = words[3] if len(words) > 3 and words[2].upper() == "AS" else base
            current = name
            stages[current] = {"base": base, "instructions": []}
            continue
        if current is not None:
            stages[current]["instructions"].append(stripped)
    return stages


def stage_ancestry(stages, name):
    """`name` and every stage it is built from, nearest first."""
    seen = []
    while name in stages and name not in seen:
        seen.append(name)
        name = stages[name]["base"]
    return seen


class ManualImageContracts(unittest.TestCase):
    def test_all_release_images_pin_the_manual_profile(self):
        for unit in UNITS:
            with self.subTest(unit=unit):
                dockerfile = (HERE / f"Dockerfile.{unit}").read_text()
                self.assertIn("ENV KNOWLEDGE_RELEASE_PROFILE=manual-v1", dockerfile)

    def test_production_web_route_manifest_excludes_deferred_routes(self):
        routes = (ROOT / "apps/knowledge/app/routes.ts").read_text()
        for deferred in (
            "api.commands",
            "api.propose-command",
            "api.transcribe",
            "settings.sources",
            "sources.$sourceId.entities.$entityId",
        ):
            with self.subTest(route=deferred):
                self.assertNotIn(deferred, routes)

    def test_deferred_drive_surface_is_gated_and_no_release_path_enables_it(self):
        """The manifest above stays clean because the Drive settings route is
        spread in by a build-time gate that is off unless an environment names
        `KNOWLEDGE_DRIVE_ENABLED=true`. That variable reaches no release image
        and no deployed revision, so the gate is what keeps the fence real
        rather than the absence of a literal from one file."""
        manifest = (ROOT / "apps/knowledge/app/routes.ts").read_text()
        gated = (ROOT / "apps/knowledge/app/routes.deferred.ts").read_text()
        self.assertIn("deferredDriveRoutes", manifest)
        self.assertIn("settings.sources", gated)
        self.assertIn("isDriveSurfaceEnabled", gated)
        # release.py rejects any environment key outside REQUIRED_ENVIRONMENT as
        # deferred runtime configuration, so its absence here is the refusal.
        self.assertNotIn(DRIVE_VARIABLE, (HERE / "release.py").read_text())
        for unit in UNITS:
            # Dockerfile.web names it in its disposable `e2e` stage, which the
            # test below pins to that stage alone.
            if unit == "web":
                continue
            with self.subTest(unit=unit):
                self.assertNotIn(
                    DRIVE_VARIABLE, (HERE / f"Dockerfile.{unit}").read_text()
                )

    def test_release_web_image_build_receives_no_drive_build_argument(self):
        """The browser harness needs the deferred Drive route compiled into its
        own web image, because a route manifest is a BUILD-time artifact. That
        is a build argument on the `e2e` stage, and this is the assertion that
        stops it reaching a release: `runtime` and every stage it descends from
        must never declare or read the variable, so passing the argument to a
        release build is inert rather than dangerous, and no release build
        command passes one at all."""
        stages = dockerfile_stages((HERE / "Dockerfile.web").read_text())
        naming = sorted(
            name
            for name, stage in stages.items()
            if any(DRIVE_VARIABLE in line for line in stage["instructions"])
        )
        self.assertEqual(naming, ["e2e"])
        self.assertIn(
            f"ARG {DRIVE_VARIABLE}",
            "\n".join(stages["e2e"]["instructions"]),
        )
        # The release image is the LAST stage, which is what an untargeted
        # `docker build` selects; walk its bases and require every one of them
        # to be argument-free.
        release = list(stages)[-1]
        self.assertEqual(release, "runtime")
        for name in stage_ancestry(stages, release):
            with self.subTest(stage=name):
                self.assertNotIn(
                    DRIVE_VARIABLE, "\n".join(stages[name]["instructions"])
                )

        # cloudbuild.yaml is the release build. It selects no target, so it
        # builds `runtime`, and it passes no build argument whatsoever.
        cloudbuild = (HERE / "cloudbuild.yaml").read_text()
        self.assertIn("docker build --file", cloudbuild)
        self.assertNotIn("--build-arg", cloudbuild)
        self.assertNotIn("--target", cloudbuild)

        # build-images.sh: the argument appears only in the `e2e` branch, and
        # the release loop that builds `--target runtime` passes none.
        script = (HERE / "build-images.sh").read_text()
        e2e_branch = script.index('if [ "$mode" = "e2e" ]')
        release_loop = script.index(
            "for unit in web query ingest parser schema retention; do"
        )
        self.assertLess(e2e_branch, release_loop)
        self.assertEqual(
            [
                index
                for index in range(len(script))
                if script.startswith(f"--build-arg {DRIVE_VARIABLE}=true", index)
            ],
            [script.index(f"--build-arg {DRIVE_VARIABLE}=true")],
        )
        self.assertLess(
            script.index(f"--build-arg {DRIVE_VARIABLE}=true"), release_loop
        )
        self.assertNotIn("--build-arg", script[release_loop:])

    def test_parser_image_keeps_test_adapter_out_of_final_finite_job(self):
        dockerfile = (HERE / "Dockerfile.parser").read_text()
        adapter = (
            "COPY contrib/deploying/knowledge/parser-container-server.mjs "
            "/usr/local/bin/parser-container-server.mjs"
        )
        self.assertIn(adapter, dockerfile)
        self.assertLess(adapter and dockerfile.index(adapter), dockerfile.index("AS runtime\n"))
        self.assertTrue(
            dockerfile.rstrip().endswith('CMD ["node", "dist/parser-job.js"]')
        )

    def test_web_e2e_target_is_distinct_from_final_production_target(self):
        dockerfile = (HERE / "Dockerfile.web").read_text()
        self.assertIn("AS e2e", dockerfile)
        self.assertIn("images-web-e2e.mjs", dockerfile)
        self.assertTrue(dockerfile.rstrip().endswith(
            'CMD ["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"]'
        ))

    def test_schema_keeps_commonjs_pg_external_to_the_esm_bundle(self):
        dockerfile = (HERE / "Dockerfile.schema").read_text()
        self.assertIn("--external pg", dockerfile)


class ParserContainerAdapter(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        temporary = Path(self.temporary.name)
        self.record = temporary / "record.json"
        self.job = temporary / "job.mjs"
        self.job.write_text(
            "import { writeFileSync } from 'node:fs';\n"
            "writeFileSync(process.env.KNOWLEDGE_TEST_RECORD, JSON.stringify({"
            "input: JSON.parse(process.env.KNOWLEDGE_PARSER_INPUT_JSON),"
            "output: JSON.parse(process.env.KNOWLEDGE_PARSER_OUTPUT_JSON)}));\n"
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            self.port = listener.getsockname()[1]
        node = shutil.which("node")
        if not node:
            self.skipTest("node is required")
        environment = {
            **os.environ,
            "PATH": f"{Path(node).parent}:{os.environ.get('PATH', '')}",
            "PORT": str(self.port),
            "KNOWLEDGE_PARSER_JOB_PATH": str(self.job),
            "KNOWLEDGE_TEST_RECORD": str(self.record),
        }
        self.server = subprocess.Popen(
            [node, str(HERE / "parser-container-server.mjs")],
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                connection = HTTPConnection("127.0.0.1", self.port, timeout=0.2)
                connection.request("GET", "/health")
                response = connection.getresponse()
                status = response.status
                response.read()
                connection.close()
                if status == 200:
                    return
            except OSError:
                time.sleep(0.02)
        self.server.wait(timeout=1)
        self.fail("parser adapter did not start")

    def tearDown(self):
        self.server.terminate()
        try:
            self.server.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.server.kill()
            self.server.wait(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, body=b"", headers=None):
        connection = HTTPConnection("127.0.0.1", self.port, timeout=2)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        connection.close()
        return response.status, payload

    def test_runs_the_finite_parser_job_with_exact_object_references(self):
        request = {
            "input": {
                "bucket": "knowledge-e2e",
                "objectKey": "input/manual.pdf",
                "generation": "7",
                "sha256": "a" * 64,
                "mimeType": "application/pdf",
                "maxBytes": 50000000,
            },
            "output": {
                "bucket": "knowledge-e2e",
                "objectKey": "output/manual.json",
            },
        }
        status, body = self.request(
            "POST",
            "/parse",
            json.dumps(request).encode(),
            {"content-type": "application/json"},
        )
        self.assertEqual((status, body), (204, b""))
        self.assertEqual(json.loads(self.record.read_text()), request)

    def test_rejects_unknown_routes_and_invalid_or_oversized_requests(self):
        self.assertEqual(self.request("GET", "/parse")[0], 405)
        self.assertEqual(
            self.request(
                "POST", "/parse", b"not json", {"content-type": "application/json"}
            )[0],
            400,
        )
        self.assertEqual(
            self.request(
                "POST",
                "/parse",
                b"{}",
                {"content-type": "application/json", "content-length": "40000"},
            )[0],
            413,
        )


if __name__ == "__main__":
    unittest.main()
