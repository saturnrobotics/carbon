import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { createDispatcher } from "./edge-main/handler.ts";
import { verifySupabaseJwt } from "./edge-main/jwt.ts";

const secret = "test-only-secret-not-for-any-deployment";
const now = 1900000000;
const userId = "10000000-0000-0000-0000-000000000001";
const claims = { role: "authenticated", sub: userId, exp: now + 3600 };
const origin = "https://erp.example.com";

function bearer(
  payload = claims,
  header = { alg: "HS256", typ: "JWT" },
  key = secret
) {
  const input = [header, payload]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `Bearer ${input}.${createHmac("sha256", key).update(input).digest("base64url")}`;
}

function request(
  path,
  { authorization, method = "POST", requestOrigin = origin, body } = {}
) {
  const headers = new Headers();
  if (authorization) headers.set("Authorization", authorization);
  if (requestOrigin) headers.set("Origin", requestOrigin);
  return new Request(`https://edge.example.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
}

function dispatcher(dispatch) {
  return createDispatcher({
    jwtSecret: secret,
    allowedOrigins: [origin, "https://mes.example.com"],
    nowSeconds: () => now,
    dispatch
  });
}

test("JWT verifier accepts correctly signed user, service and anon tokens", async () => {
  for (const payload of [
    claims,
    { role: "service_role", exp: now + 60 },
    { role: "anon", exp: now + 60 }
  ]) {
    assert.deepEqual(
      await verifySupabaseJwt(bearer(payload), secret, now),
      payload
    );
  }
});

test("JWT verifier rejects forged service role, wrong key and algorithm confusion", async () => {
  const forged = bearer(
    { role: "service_role", exp: now + 60 },
    undefined,
    "attacker-key"
  );
  const tokens = [
    forged,
    bearer(claims, { alg: "none" }),
    bearer(claims, { alg: "RS256" }),
    bearer(claims, { alg: "HS256", crit: ["b64"], b64: false }),
    "Bearer e30.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.",
    "Bearer invalid",
    null
  ];
  for (const token of tokens) {
    assert.equal(await verifySupabaseJwt(token, secret, now), null);
  }
  assert.equal(await verifySupabaseJwt(bearer(), "", now), null);
});

test("JWT verifier rejects expired, premature, malformed and privileged claims", async () => {
  for (const payload of [
    { ...claims, exp: now },
    { ...claims, exp: now - 1 },
    { ...claims, exp: `${now + 1}` },
    { ...claims, exp: undefined },
    { ...claims, nbf: now + 1 },
    { ...claims, nbf: "invalid" },
    { ...claims, role: "supabase_admin" },
    { ...claims, role: ["service_role"] },
    { ...claims, sub: undefined },
    { ...claims, is_anonymous: true }
  ]) {
    assert.equal(await verifySupabaseJwt(bearer(payload), secret, now), null);
  }
});

test("dispatcher never creates a worker for missing or forged authorization", async () => {
  let workers = 0;
  const handle = dispatcher(async () => {
    workers++;
    return new Response("unexpected");
  });
  for (const authorization of [undefined, bearer(claims, undefined, "wrong")]) {
    const result = await handle(request("/post-picking", { authorization }));
    assert.equal(result.status, 401);
    assert.equal(result.headers.get("Access-Control-Allow-Origin"), origin);
  }
  assert.equal(workers, 0);
});

test("dispatcher permits signed user and service token requests", async () => {
  const seen = [];
  const handle = dispatcher(async (name) => {
    seen.push(name);
    return new Response("ok");
  });
  for (const authorization of [
    bearer(),
    bearer({ role: "service_role", exp: now + 60 })
  ]) {
    assert.equal(
      (await handle(request("/post-picking", { authorization }))).status,
      200
    );
  }
  assert.deepEqual(seen, ["post-picking", "post-picking"]);
});

test("signed anon is limited to event-wake", async () => {
  const seen = [];
  const handle = dispatcher(async (name) => {
    seen.push(name);
    return new Response("ok");
  });
  const authorization = bearer({ role: "anon", exp: now + 60 });
  assert.equal(
    (await handle(request("/event-wake", { authorization }))).status,
    200
  );
  assert.equal(
    (await handle(request("/post-picking", { authorization }))).status,
    403
  );
  assert.equal((await handle(request("/event-wake"))).status, 401);
  assert.deepEqual(seen, ["event-wake"]);
});

test("only the two explicit image upload POSTs bypass bearer verification", async () => {
  const seen = [];
  const handle = dispatcher(async (name) => {
    seen.push(name);
    return new Response("image");
  });
  for (const path of ["/image-resizer", "/logo-resizer"]) {
    assert.equal((await handle(request(path))).status, 200);
    assert.equal((await handle(request(path, { method: "GET" }))).status, 401);
  }
  assert.equal((await handle(request("/image-resizer-extra"))).status, 401);
  assert.deepEqual(seen, ["image-resizer", "logo-resizer"]);
});

test("CORS preflight does not execute functions and rejects outside origins", async () => {
  let workers = 0;
  const handle = dispatcher(async () => {
    workers++;
    return new Response("unexpected");
  });
  const allowed = await handle(request("/post-picking", { method: "OPTIONS" }));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), origin);
  const denied = await handle(
    request("/post-picking", {
      method: "OPTIONS",
      requestOrigin: "https://other.example"
    })
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(workers, 0);
});

test("dispatcher rejects path traversal and hides worker exceptions", async () => {
  let workers = 0;
  const handle = dispatcher(async () => {
    workers++;
    throw new Error("private connection string");
  });
  for (const path of ["/", "/%2e%2e%2flib", "/%2Fpost-picking", "/_private"]) {
    assert.equal(
      (await handle(request(path, { authorization: bearer() }))).status,
      404
    );
  }
  assert.equal(workers, 0);
  const failure = await handle(
    request("/post-picking", { authorization: bearer() })
  );
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), {
    message: "Function execution failed"
  });
});

// Integrate the dispatcher with Carbon's actual permissions helper and a local
// PostgREST stub. No external account, database or third-party network is used.
let rpcServer;
let requirePermissions;
const permissionLookups = [];
let previousDeno;

before(async () => {
  rpcServer = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    permissionLookups.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        role: "employee",
        inventory_update: ["company-fixture"]
      })
    );
  });
  await new Promise((resolve) => rpcServer.listen(0, "127.0.0.1", resolve));
  const address = rpcServer.address();
  const env = {
    SUPABASE_URL: `http://127.0.0.1:${address.port}`,
    SUPABASE_SERVICE_ROLE_KEY: bearer({
      role: "service_role",
      exp: now + 60
    }).slice(7)
  };
  previousDeno = globalThis.Deno;
  globalThis.Deno = { env: { get: (key) => env[key] } };
  ({ requirePermissions } = await import(
    "../../../../packages/database/supabase/functions/lib/supabase.ts"
  ));
});

after(async () => {
  globalThis.Deno = previousDeno;
  await new Promise((resolve) => rpcServer.close(resolve));
});

function protectedDispatcher() {
  return dispatcher(async (_, req) => {
    const body = await req.json();
    try {
      await requirePermissions(req, "company-fixture", body.userId, {
        update: "inventory"
      });
      return new Response("authorized");
    } catch (error) {
      return new Response(error.message, { status: 403 });
    }
  });
}

test("authenticated edge caller cannot obtain another user's permissions", async () => {
  permissionLookups.length = 0;
  const result = await protectedDispatcher()(
    request("/post-picking", {
      authorization: bearer(),
      body: { userId: "another-user" }
    })
  );
  assert.equal(result.status, 403);
  assert.match(await result.text(), /does not match/);
  assert.deepEqual(permissionLookups, []);
});

test("authenticated edge caller uses own permission lookup", async () => {
  permissionLookups.length = 0;
  const result = await protectedDispatcher()(
    request("/post-picking", {
      authorization: bearer(),
      body: { userId }
    })
  );
  assert.equal(result.status, 200);
  assert.deepEqual(permissionLookups, [
    { uid: userId, company: "company-fixture" }
  ]);
});

test("trusted service operations remain allowed only after signature verification", async () => {
  permissionLookups.length = 0;
  const handle = protectedDispatcher();
  const payload = { role: "service_role", exp: now + 60 };
  const trusted = await handle(
    request("/post-picking", {
      authorization: bearer(payload),
      body: { userId: "job-actor" }
    })
  );
  assert.equal(trusted.status, 200);
  const forged = await handle(
    request("/post-picking", {
      authorization: bearer(payload, undefined, "attacker"),
      body: { userId: "job-actor" }
    })
  );
  assert.equal(forged.status, 401);
  assert.deepEqual(permissionLookups, []);
});
