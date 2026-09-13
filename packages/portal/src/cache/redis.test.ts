import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createRedisCache } from "./redis.server";

let directory: string;
const path = (name: string) => join(directory, name);
const openssl = (...args: string[]) =>
  execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "portal-redis-tls-"));
  for (const name of ["ca", "untrusted"]) {
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${name}.example.com`,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.pem`
    );
  }
  openssl(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=cache.example.com",
    "-keyout",
    "server.key",
    "-out",
    "server.csr"
  );
  for (const [name, san] of [
    ["server", "IP:127.0.0.1"],
    ["mismatched", "DNS:cache.example.com"]
  ]) {
    writeFileSync(path(`${name}.ext`), `subjectAltName=${san}\n`);
    openssl(
      "x509",
      "-req",
      "-in",
      "server.csr",
      "-CA",
      "ca.pem",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "1",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.pem`
    );
  }
}, 20_000);

afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** A loopback TLS endpoint speaking just the Redis commands this cache uses. */
async function withRedisTls(
  certificate: string,
  run: (url: string) => Promise<void>
) {
  const sockets = new Set<TLSSocket>();
  const values = new Map<string, string>();
  const server = createServer(
    {
      key: readFileSync(path("server.key")),
      cert: readFileSync(path(certificate))
    },
    (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let pending = "";
      socket.on("data", (data) => {
        pending += data.toString();
        while (pending) {
          const header = /^\*(\d+)\r\n/.exec(pending);
          if (!header) return;
          let offset = header[0].length;
          const args: string[] = [];
          for (let index = 0; index < Number(header[1]); index++) {
            const size = /^\$(\d+)\r\n/.exec(pending.slice(offset));
            if (!size) return;
            const start = offset + size[0].length;
            const end = start + Number(size[1]);
            if (pending.length < end + 2) return;
            args.push(pending.slice(start, end));
            offset = end + 2;
          }
          pending = pending.slice(offset);
          const [command, key, value] = args;
          if (command?.toLowerCase() === "info") {
            socket.write("$11\r\nloading:0\r\n\r\n");
          } else if (command?.toLowerCase() === "get") {
            const stored = values.get(key!);
            socket.write(
              stored === undefined
                ? "$-1\r\n"
                : `$${stored.length}\r\n${stored}\r\n`
            );
          } else {
            if (command?.toLowerCase() === "set") values.set(key!, value!);
            socket.write("+OK\r\n");
          }
        }
      });
    }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing test address");
  try {
    await run(`rediss://127.0.0.1:${address.port}`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

it("reads and writes over TLS using the explicitly configured CA file", async () => {
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("ca.pem"));
  await withRedisTls("server.pem", async (url) => {
    const cache = createRedisCache(url);
    try {
      await cache.store.set("synthetic", { answer: true }, 10);
      expect(await cache.store.get("synthetic")).toEqual({ answer: true });
    } finally {
      await cache.close();
    }
  });
});

it("rejects a missing configured CA file before connecting without exposing its path", () => {
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("missing.pem"));
  expect(() => createRedisCache("rediss://127.0.0.1:1")).toThrow(
    /^Invalid Redis TLS CA file$/
  );
});

it("rejects malformed configured certificates before connecting", () => {
  writeFileSync(path("invalid.pem"), "not a certificate");
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("invalid.pem"));
  expect(() => createRedisCache("rediss://127.0.0.1:1")).toThrow(
    /^Invalid Redis TLS CA file$/
  );
});

it("rejects a configured CA when the URL would use plaintext", () => {
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("ca.pem"));
  expect(() => createRedisCache("redis://127.0.0.1:1")).toThrow(
    "Redis TLS CA file requires a TLS URL"
  );
});

it("rejects a certificate signed by an untrusted CA", async () => {
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("untrusted.pem"));
  await withRedisTls("server.pem", async (url) => {
    const cache = createRedisCache(url);
    try {
      await expect(cache.store.get("synthetic")).rejects.toThrow();
    } finally {
      await cache.close();
    }
  });
});

it("still verifies the server hostname when its CA is trusted", async () => {
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("ca.pem"));
  await withRedisTls("mismatched.pem", async (url) => {
    const cache = createRedisCache(url);
    try {
      await expect(cache.store.get("synthetic")).rejects.toThrow();
    } finally {
      await cache.close();
    }
  });
});

it("accepts every CA in a rotation bundle", async () => {
  writeFileSync(
    path("bundle.pem"),
    readFileSync(path("untrusted.pem"), "utf8") +
      readFileSync(path("ca.pem"), "utf8")
  );
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("bundle.pem"));
  await withRedisTls("server.pem", async (url) => {
    const cache = createRedisCache(url);
    try {
      await cache.store.set("synthetic", { answer: true }, 10);
      expect(await cache.store.get("synthetic")).toEqual({ answer: true });
    } finally {
      await cache.close();
    }
  });
});

it.each([
  "",
  "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
  "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----"
])("rejects an empty or invalid PEM certificate bundle", (contents) => {
  writeFileSync(path("invalid-bundle.pem"), contents);
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", path("invalid-bundle.pem"));
  expect(() => createRedisCache("rediss://127.0.0.1:1")).toThrow(
    /^Invalid Redis TLS CA file$/
  );
});

it("keeps local plaintext development available without a configured CA", async () => {
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", undefined);
  const cache = createRedisCache("redis://127.0.0.1:1");
  await cache.close();
});

it("does not trust a private server CA when no CA file is configured", async () => {
  vi.stubEnv("PORTAL_REDIS_TLS_CA_FILE", undefined);
  await withRedisTls("server.pem", async (url) => {
    const cache = createRedisCache(url);
    try {
      await expect(cache.store.get("synthetic")).rejects.toThrow();
    } finally {
      await cache.close();
    }
  });
});
