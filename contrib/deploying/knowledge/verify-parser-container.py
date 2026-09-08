#!/usr/bin/env python3
"""Run the production parser image against real PDF/OCR binaries and fake GCS."""

from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import uuid4


PARSER_IMAGE = os.environ.get(
    "KNOWLEDGE_PARSER_TEST_IMAGE", "knowledge-manual-local-parser:manual-v1"
)
PARSER_E2E_IMAGE = "knowledge-manual-local-parser-e2e:manual-v1"
PARSER_PLATFORM = None
STORAGE_IMAGE = "fsouza/fake-gcs-server:1.56.1"
BUCKET = "knowledge-e2e"


def run(*arguments, capture=False):
    result = subprocess.run(
        arguments,
        check=True,
        text=True,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
    )
    return result.stdout if capture else None


def synthetic_pdf(text):
    stream = f"BT /F1 32 Tf 72 650 Td ({text}) Tj ET\n".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream",
    ]
    document = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, value in enumerate(objects, 1):
        offsets.append(len(document))
        document.extend(f"{number} 0 obj\n".encode())
        document.extend(value)
        document.extend(b"\nendobj\n")
    xref = len(document)
    document.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    document.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        document.extend(f"{offset:010d} 00000 n \n".encode())
    document.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(document)


class StorageApi:
    def __init__(self, origin):
        self.origin = origin

    def request(self, method, path, body=None, content_type="application/json"):
        request = Request(
            f"{self.origin}{path}",
            data=body,
            method=method,
            headers={"content-type": content_type},
        )
        with urlopen(request, timeout=5) as response:
            payload = response.read()
        return json.loads(payload) if payload else None

    def create_bucket(self):
        return self.request(
            "POST", "/storage/v1/b?project=knowledge-test", json.dumps({"name": BUCKET}).encode()
        )

    def upload(self, object_key, content_type, body):
        return self.request(
            "POST",
            f"/upload/storage/v1/b/{BUCKET}/o?uploadType=media&name={quote(object_key, safe='')}",
            body,
            content_type,
        )

    def metadata(self, object_key):
        return self.request(
            "GET", f"/storage/v1/b/{BUCKET}/o/{quote(object_key, safe='')}"
        )

    def download(self, object_key, generation):
        path = (
            f"/download/storage/v1/b/{BUCKET}/o/{quote(object_key, safe='')}"
            f"?alt=media&generation={quote(str(generation), safe='')}"
        )
        request = Request(f"{self.origin}{path}")
        with urlopen(request, timeout=5) as response:
            return response.read()


def mapped_storage_origin(container):
    port = run(
        "docker", "port", container, "4443/tcp", capture=True
    ).strip().rsplit(":", 1)[-1]
    return f"http://127.0.0.1:{port}"


def wait_for_storage(origin):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with urlopen(f"{origin}/storage/v1/b", timeout=0.5):
                return
        except (HTTPError, URLError):
            time.sleep(0.1)
    raise RuntimeError("fake GCS did not become ready")


def parser_command(network, reference, output_key):
    environment = {
        "STORAGE_EMULATOR_HOST": "http://storage-api:8081",
        "GOOGLE_CLOUD_PROJECT": "knowledge-test",
        "KNOWLEDGE_PARSER_INPUT_JSON": json.dumps(reference, separators=(",", ":")),
        "KNOWLEDGE_PARSER_OUTPUT_JSON": json.dumps(
            {"bucket": BUCKET, "objectKey": output_key}, separators=(",", ":")
        ),
    }
    command = [
        "docker", "run", "--rm", "--platform", PARSER_PLATFORM,
        "--network", network,
    ]
    for name, value in environment.items():
        command.extend(("--env", f"{name}={value}"))
    command.append(PARSER_IMAGE)
    return command


def invoke_parser(network, reference, output_key):
    command = parser_command(network, reference, output_key)
    result = subprocess.run(command)
    if result.returncode == 0:
        return
    diagnostic = [
        *command,
        "node",
        "--input-type=module",
        "--eval",
        "import('/app/dist/parser-job.js')"
        ".then(({runParserJob}) => runParserJob())"
        ".catch((error) => { console.error(error); process.exit(1); })",
    ]
    subprocess.run(diagnostic, check=False)
    raise subprocess.CalledProcessError(result.returncode, command)


def assert_parser_rejects(network, reference, output_key):
    result = subprocess.run(
        parser_command(network, reference, output_key),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    if result.returncode == 0:
        raise AssertionError("parser accepted a nonexistent immutable generation")


def main():
    global PARSER_PLATFORM
    suffix = uuid4().hex[:10]
    network = f"knowledge-parser-{suffix}"
    storage = f"knowledge-parser-storage-{suffix}"
    storage_proxy = f"knowledge-parser-storage-proxy-{suffix}"
    image_info = json.loads(
        run("docker", "image", "inspect", PARSER_IMAGE, capture=True)
    )[0]
    PARSER_PLATFORM = f"{image_info['Os']}/{image_info['Architecture']}"
    languages = run(
        "docker",
        "run",
        "--rm",
        "--platform",
        PARSER_PLATFORM,
        "--entrypoint",
        "/usr/bin/tesseract",
        PARSER_IMAGE,
        "--list-langs",
        capture=True,
    )
    if "eng" not in languages.split():
        raise AssertionError("parser image does not contain English OCR language data")
    run("docker", "network", "create", "--label", "knowledge.disposable=true", network)
    try:
        run(
            "docker", "run", "--detach", "--rm",
            "--name", storage,
            "--label", "knowledge.disposable=true",
            "--network", network,
            "--network-alias", "storage",
            "--publish", "127.0.0.1::4443",
            "--entrypoint", "/bin/fake-gcs-server",
            STORAGE_IMAGE,
            "-scheme", "http",
            "-backend", "memory",
            "-external-url", "http://storage:4443",
        )
        origin = mapped_storage_origin(storage)
        wait_for_storage(origin)
        run(
            "docker", "run", "--detach", "--rm",
            "--name", storage_proxy,
            "--label", "knowledge.disposable=true",
            "--network", network,
            "--network-alias", "storage-api",
            "--env", "PORT=8081",
            PARSER_E2E_IMAGE,
            "node", "/usr/local/bin/images-storage-emulator-proxy.mjs",
        )
        api = StorageApi(origin)
        api.create_bucket()
        with tempfile.TemporaryDirectory() as directory_name:
            directory = Path(directory_name)
            pdf_bytes = synthetic_pdf("PDF MANUAL ALPHA 4827")
            image_source = directory / "image-source.pdf"
            image_source.write_bytes(synthetic_pdf("IMAGE MANUAL BRAVO 7391"))
            run(
                "docker", "run", "--rm",
                "--entrypoint", "/usr/bin/pdftoppm",
                "--volume", f"{directory}:/fixtures",
                PARSER_E2E_IMAGE,
                "-png", "-r", "200",
                "/fixtures/image-source.pdf", "/fixtures/image",
            )
            png_bytes = (directory / "image-1.png").read_bytes()

        fixtures = (
            ("pdf", "input/manual-alpha.pdf", "application/pdf", pdf_bytes, "PDF MANUAL ALPHA 4827"),
            ("image", "input/manual-bravo.png", "image/png", png_bytes, "IMAGE MANUAL BRAVO 7391"),
        )
        evidence = []
        for kind, object_key, mime_type, body, expected_text in fixtures:
            uploaded = api.upload(object_key, mime_type, body)
            reference = {
                "bucket": BUCKET,
                "objectKey": object_key,
                "generation": str(uploaded["generation"]),
                "sha256": sha256(body).hexdigest(),
                "mimeType": mime_type,
                "maxBytes": 50_000_000,
            }
            output_key = f"output/{kind}-{reference['sha256'][:16]}.json"
            invoke_parser(network, reference, output_key)
            output_metadata = api.metadata(output_key)
            output_bytes = api.download(output_key, output_metadata["generation"])
            extraction = json.loads(output_bytes)
            extracted_text = " ".join(
                item["text"] for item in extraction["evidence"]["body"]
            )
            if expected_text not in " ".join(extracted_text.split()):
                raise AssertionError(
                    f"{kind} extraction omitted its synthetic identifier: {extracted_text!r}"
                )
            original_output_generation = str(output_metadata["generation"])
            invoke_parser(network, reference, output_key)
            retry_metadata = api.metadata(output_key)
            if str(retry_metadata["generation"]) != original_output_generation:
                raise AssertionError("idempotent parser retry replaced immutable output")
            invalid_reference = {**reference, "generation": "9999999999999999999"}
            assert_parser_rejects(
                network, invalid_reference, f"output/rejected-{kind}.json"
            )
            evidence.append({
                "kind": kind,
                "input": {
                    "objectKey": object_key,
                    "generation": reference["generation"],
                    "sha256": reference["sha256"],
                },
                "output": {
                    "objectKey": output_key,
                    "generation": str(output_metadata["generation"]),
                    "sha256": sha256(output_bytes).hexdigest(),
                },
                "textIdentifier": expected_text,
                "duplicateWriteGenerationUnchanged": True,
                "wrongGenerationRejected": True,
            })
        image_id = run(
            "docker", "image", "inspect", PARSER_IMAGE,
            "--format", "{{.Id}}", capture=True
        ).strip()
        print(json.dumps({
            "image": PARSER_IMAGE,
            "imageId": image_id,
            "platform": PARSER_PLATFORM,
            "proofs": evidence,
        }, indent=2))
    finally:
        subprocess.run(
            ["docker", "container", "stop", storage_proxy],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["docker", "container", "stop", storage],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        subprocess.run(
            ["docker", "network", "rm", network],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


if __name__ == "__main__":
    main()
