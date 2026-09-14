import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { Pool, type PoolConfig } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { portalPoolConfig } from "./database.server";

describe("Portal PostgreSQL verify-full", () => {
  let directory: string;
  let server: Server | undefined;
  const sockets = new Set<Socket>();

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "portal-postgres-tls-"));
    const openssl = (...args: string[]) =>
      execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "ca.key",
      "-out",
      "ca.pem",
      "-days",
      "1",
      "-subj",
      "/CN=Synthetic Root"
    );
    for (const [name, san] of [
      ["server", "IP:127.0.0.1,IP:::1"],
      ["dns", "DNS:localhost"],
      ["wrong", "IP:127.0.0.2,DNS:wrong.example.test"]
    ] as const) {
      openssl(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.csr`,
        "-subj",
        "/CN=Synthetic PostgreSQL"
      );
      writeFileSync(
        join(directory, `${name}.ext`),
        `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`
      );
      openssl(
        "x509",
        "-req",
        "-in",
        `${name}.csr`,
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        `${name}.pem`,
        "-days",
        "1",
        "-extfile",
        `${name}.ext`
      );
    }
  }, 30_000);

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) {
      const current = server;
      server = undefined;
      await new Promise<void>((resolve) => current.close(() => resolve()));
    }
  });

  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  async function endpoint(certificate = "server", host = "127.0.0.1") {
    const secureContext = createSecureContext({
      cert:
        readFileSync(join(directory, `${certificate}.pem`), "utf8") +
        readFileSync(join(directory, "ca.pem"), "utf8"),
      key: readFileSync(join(directory, `${certificate}.key`))
    });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.once("data", (request) => {
        // PostgreSQL's SSLRequest precedes the TLS handshake.
        expect(request).toEqual(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
        socket.write("S");
        const secure = new TLSSocket(socket, { isServer: true, secureContext });
        sockets.add(secure);
        secure.on("error", () => {
          // Negative tests deliberately reject the server certificate.
        });
        // A minimal PostgreSQL startup response proves pg completed TLS before login.
        secure.once("data", () =>
          secure.write(
            Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73])
          )
        );
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("TCP listener required");
    const url = new URL(
      `postgresql://synthetic:synthetic@${host}:${address.port}/synthetic`
    );
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.set("sslrootcert", join(directory, "ca.pem"));
    return url;
  }

  async function connect(connectionString: string) {
    const pool = new Pool(
      portalPoolConfig({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 1000
      })
    );
    try {
      const client = await pool.connect();
      client.release();
    } finally {
      await pool.end();
    }
  }

  it("authenticates the URL's IP SAN through pg's actual TLS upgrade", async () => {
    await expect(
      connect((await endpoint()).toString())
    ).resolves.toBeUndefined();
  });

  it("normalizes bracketed IPv6 without changing Node's certificate verifier", () => {
    const config = portalPoolConfig({
      connectionString:
        "postgresql://synthetic:synthetic@[::1]/synthetic?sslmode=verify-full"
    });
    expect(config.ssl).toEqual({ host: "::1", rejectUnauthorized: true });
    expect(new URL(config.connectionString!).searchParams.get("host")).toBe(
      "::1"
    );
  });

  it("uses pg's host query override for the connection and verification", async () => {
    const url = await endpoint();
    url.hostname = "unused.example.test";
    url.searchParams.set("host", "127.0.0.1");
    await expect(connect(url.toString())).resolves.toBeUndefined();
  });

  it("rejects a trusted certificate with the wrong IP SAN", async () => {
    await expect(
      connect((await endpoint("wrong")).toString())
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("rejects an untrusted certificate even when its IP SAN matches", async () => {
    const url = await endpoint();
    url.searchParams.delete("sslrootcert");
    await expect(connect(url.toString())).rejects.toMatchObject({
      code: "SELF_SIGNED_CERT_IN_CHAIN"
    });
  });

  it("preserves DNS hostname verification", async () => {
    await expect(
      connect((await endpoint("dns", "localhost")).toString())
    ).resolves.toBeUndefined();
  });

  it("rejects a trusted certificate with the wrong DNS name", async () => {
    await expect(
      connect((await endpoint("wrong", "localhost")).toString())
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("retains certificate material and non-TLS options without URL overrides", () => {
    const url = new URL(
      "postgresql://synthetic:synthetic@127.0.0.1/synthetic?sslmode=verify-full&application_name=portal-test&ssl=0&uselibpqcompat=true"
    );
    for (const [parameter, file] of [
      ["sslrootcert", "ca.pem"],
      ["sslcert", "server.pem"],
      ["sslkey", "server.key"]
    ] as const) {
      url.searchParams.set(parameter, join(directory, file));
    }
    const config = portalPoolConfig({
      connectionString: url.toString(),
      max: 3,
      statement_timeout: 2000
    });
    expect(config).toMatchObject({
      max: 3,
      statement_timeout: 2000,
      ssl: {
        host: "127.0.0.1",
        rejectUnauthorized: true,
        ca: readFileSync(join(directory, "ca.pem"), "utf8"),
        cert: readFileSync(join(directory, "server.pem"), "utf8"),
        key: readFileSync(join(directory, "server.key"), "utf8")
      }
    });
    const result = new URL(config.connectionString!);
    expect([...result.searchParams.keys()].sort()).toEqual([
      "application_name",
      "host"
    ]);
    expect(result.searchParams.get("application_name")).toBe("portal-test");
    expect(result.username).toBe(url.username);
    expect(result.password).toBe(url.password);
  });

  it.each([
    "sslmode",
    "ssl",
    "sslrootcert",
    "sslcert",
    "sslkey",
    "uselibpqcompat"
  ])("rejects ambiguous duplicate %s parameters", (parameter) => {
    const url = new URL(
      "postgresql://synthetic:synthetic@127.0.0.1/synthetic?sslmode=verify-full"
    );
    url.searchParams.append(parameter, "first");
    url.searchParams.append(parameter, "second");
    expect(() =>
      portalPoolConfig({ connectionString: url.toString() })
    ).toThrow("Duplicate Portal database TLS parameter");
  });

  it("redacts invalid database URLs", () => {
    expect(() =>
      portalPoolConfig({ connectionString: "synthetic-secret-invalid-url" })
    ).toThrow(/^Invalid Portal database URL$/);
  });

  it("preserves options when pg connection defaults are used", () => {
    expect(portalPoolConfig({ max: 3 })).toEqual({ max: 3 });
  });

  it("preserves plaintext disposable connection options and pool limits", () => {
    const config: PoolConfig = {
      connectionString:
        "postgresql://synthetic:synthetic@localhost/synthetic?sslmode=disable",
      max: 3,
      statement_timeout: 2000
    };
    expect(portalPoolConfig(config)).toEqual(config);
  });
});
