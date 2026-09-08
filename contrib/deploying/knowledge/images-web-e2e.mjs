import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const app = "/repo/apps/knowledge";
const certificateDirectory = resolve(app, "tests/harness/.cert");
const key = resolve(certificateDirectory, "key.pem");
const certificate = resolve(certificateDirectory, "cert.pem");

if (!existsSync(key) || !existsSync(certificate)) {
  mkdirSync(certificateDirectory, { recursive: true });
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-keyout",
    key,
    "-out",
    certificate,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=IP:127.0.0.1,DNS:localhost"
  ]);
}

const child = spawn(
  "corepack",
  [
    "pnpm",
    "exec",
    "react-router",
    "dev",
    "--config",
    "vite.e2e.config.ts",
    "--host",
    "0.0.0.0"
  ],
  { cwd: app, env: process.env, stdio: "inherit" }
);

for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => child.kill(signal));
child.once("exit", (code) => process.exit(code ?? 1));
