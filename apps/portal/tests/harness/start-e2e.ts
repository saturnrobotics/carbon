/** Starts the browser-only loopback server with an ephemeral certificate.
 * This is test infrastructure: it is not a production TLS configuration. */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const directory = resolve(import.meta.dirname, ".cert");
const key = resolve(directory, "key.pem");
const certificate = resolve(directory, "cert.pem");
if (!existsSync(key) || !existsSync(certificate)) {
  mkdirSync(directory, { recursive: true });
  execFileSync(
    "openssl",
    [
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
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost"
    ],
    { stdio: "ignore" }
  );
}
const child = spawn(
  "corepack",
  ["pnpm", "exec", "react-router", "dev", "--config", "vite.e2e.config.ts"],
  {
    cwd: resolve(import.meta.dirname, "../.."),
    env: process.env,
    stdio: "inherit"
  }
);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once("exit", (code) => process.exit(code ?? 1));
