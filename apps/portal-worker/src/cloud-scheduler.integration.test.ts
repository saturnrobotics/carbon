import { randomUUID } from "node:crypto";
import { claimOutbox } from "@carbon/portal/indexing/outbox.server";
import { createExtraction } from "@carbon/portal/intake/extraction";
import { getDisposableLocalDatabaseUrl } from "@carbon/portal/test/database";
import pg from "pg";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import {
  createCloudSchedulerHandler,
  type SchedulerRuntime
} from "./cloud-scheduler";
import { processPortalOutbox } from "./processor";

const databaseUrl = new URL(getDisposableLocalDatabaseUrl());
databaseUrl.username = "supabase_admin";
const admin = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2 });
const ingest = new pg.Pool({
  connectionString: databaseUrl.toString(),
  options: "-c role=portal_ingest",
  max: 4
});
const companyId = "company-a";
const sourceId = `scheduler-proof-${randomUUID()}`;
const principal = { companyId, sourceId, callerId: "scheduler-proof" };

beforeAll(async () => {
  await admin.query(
    `INSERT INTO portal.source(id,"companyId","createdBy",kind,"externalId","displayName","ownerId",classification,"providerPolicy")
     VALUES ($1,$2,'alice','upload',$1,'Synthetic scheduler source','alice','internal',$3::jsonb)`,
    [
      sourceId,
      companyId,
      JSON.stringify({
        machineCallers: [principal.callerId],
        ingestDatabaseRoles: ["supabase_admin"]
      })
    ]
  );
});

afterEach(async () => {
  await admin.query(
    `DELETE FROM portal.outbox WHERE "companyId"=$1 AND "sourceId"=$2`,
    [companyId, sourceId]
  );
  await admin.query(
    `DELETE FROM portal.extraction WHERE "companyId"=$1 AND "intakeId" IN (SELECT id FROM portal.intake WHERE "companyId"=$1 AND "sourceId"=$2)`,
    [companyId, sourceId]
  );
  await admin.query(
    `DELETE FROM portal.intake WHERE "companyId"=$1 AND "sourceId"=$2`,
    [companyId, sourceId]
  );
});

afterAll(async () => {
  await admin.query(
    `DELETE FROM portal.source WHERE "companyId"=$1 AND id=$2`,
    [companyId, sourceId]
  );
  await Promise.all([ingest.end(), admin.end()]);
});

async function capturedIntake() {
  const intakeId = `intake-${randomUUID()}`;
  const eventId = `outbox-${randomUUID()}`;
  await admin.query(
    `INSERT INTO portal.intake(id,"companyId","createdBy","sourceId","ownerId","inputRefs","idempotencyKey")
     VALUES ($1,$2,'alice',$3,'alice',$4::jsonb,$1)`,
    [
      intakeId,
      companyId,
      sourceId,
      JSON.stringify([
        {
          kind: "object",
          objectKey: "synthetic/manual.pdf",
          generation: "1",
          sha256: "a".repeat(64),
          mimeType: "application/pdf",
          bytes: 100
        }
      ])
    ]
  );
  await admin.query(
    `INSERT INTO portal.outbox(id,"companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType")
     VALUES ($1,$2,'alice',$3,'intake',$4,'1','upsert')`,
    [eventId, companyId, sourceId, intakeId]
  );
  return { intakeId, eventId };
}

async function outbox(eventId: string) {
  const result = await admin.query<{
    attempts: number;
    leaseOwner: string | null;
    leaseSeconds: number | null;
    delivered: boolean;
  }>(
    `SELECT attempts,"leaseOwner",extract(epoch FROM "leaseUntil"-now())::float8 AS "leaseSeconds",("deliveredAt" IS NOT NULL) AS delivered
     FROM portal.outbox WHERE "companyId"=$1 AND id=$2`,
    [companyId, eventId]
  );
  return result.rows[0]!;
}

it("uses a 600-second lease so a slow parser cannot be reclaimed at the old five-minute boundary", async () => {
  const captured = await capturedIntake();
  const first = await claimOutbox(
    ingest,
    principal,
    "first",
    1,
    ["upsert"],
    600
  );
  expect(first.map((event) => event.id)).toEqual([captured.eventId]);
  const leased = await outbox(captured.eventId);
  expect(leased.leaseSeconds).toBeGreaterThan(590);
  expect(leased.leaseSeconds).toBeLessThanOrEqual(600);
  await admin.query(
    `UPDATE portal.outbox SET "leaseUntil"="leaseUntil"-interval '301 seconds',version=version+1 WHERE "companyId"=$1 AND id=$2`,
    [companyId, captured.eventId]
  );
  expect(
    await claimOutbox(ingest, principal, "duplicate", 1, ["upsert"], 600)
  ).toEqual([]);
  expect((await outbox(captured.eventId)).attempts).toBe(1);
  await admin.query(
    `UPDATE portal.outbox SET "leaseUntil"=now()-interval '1 second',version=version+1 WHERE "companyId"=$1 AND id=$2`,
    [companyId, captured.eventId]
  );
  const reclaimed = await claimOutbox(
    ingest,
    principal,
    "replacement",
    1,
    ["upsert"],
    600
  );
  expect(reclaimed.map((event) => event.id)).toEqual([captured.eventId]);
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 2,
    leaseOwner: "replacement",
    delivered: false
  });
});

const parsedDocument = () =>
  createExtraction({
    fields: { title: "Synthetic maintenance procedure" },
    evidence: { title: [{ page: 1, text: "Synthetic maintenance procedure" }] }
  });

async function intakeState(intakeId: string) {
  const result = await admin.query<{
    state: string;
    generation: string;
    extractions: number;
  }>(
    `SELECT state,generation::text,(SELECT count(*)::int FROM portal.extraction e WHERE e."companyId"=i."companyId" AND e."intakeId"=i.id) AS extractions
     FROM portal.intake i WHERE i."companyId"=$1 AND i.id=$2`,
    [companyId, intakeId]
  );
  return result.rows[0]!;
}

function processor(parseDocument = async () => parsedDocument()) {
  return {
    pool: ingest,
    bucket: "synthetic-parser-bucket",
    automationUserId: "alice",
    manualSourceId: sourceId,
    parseDocument
  };
}

it("does not commit a parser result after extraction was aborted", async () => {
  const captured = await capturedIntake();
  const events = await claimOutbox(
    ingest,
    principal,
    "aborted-worker",
    1,
    ["upsert"],
    600
  );
  const abort = new AbortController();
  const parse = vi.fn(async () => {
    abort.abort();
    return parsedDocument();
  });
  await expect(
    processPortalOutbox(processor(parse), principal, events[0]!, abort.signal)
  ).rejects.toThrow();
  expect(parse).toHaveBeenCalledOnce();
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "captured",
    generation: "1",
    extractions: 0
  });
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 1,
    delivered: false
  });
});

const configuration = {
  audience: "https://scheduler.example.com",
  subject: "100000000000000000003"
};
const verifiedService = {
  async verifyServiceToken(token: string, audience: string) {
    if (token !== "synthetic.payload.signature")
      throw Error("Invalid synthetic signature");
    const now = Math.floor((performance.timeOrigin + performance.now()) / 1000);
    return {
      iss: "https://accounts.google.com",
      sub: configuration.subject,
      aud: audience,
      iat: now - 1,
      exp: now + 300
    };
  }
};
function request(path = "drain", options: RequestInit = {}) {
  return new Request(`${configuration.audience}/internal/outbox/${path}`, {
    method: "POST",
    headers: { authorization: "Bearer synthetic.payload.signature" },
    ...options
  });
}
function scheduler(
  process: SchedulerRuntime["process"] = (actor, event, signal) =>
    processPortalOutbox(processor(), actor, event, signal)
) {
  return {
    pool: ingest,
    companies: [{ companyId, callerId: principal.callerId }],
    sourceId,
    process
  };
}
async function expireLease(eventId: string) {
  await admin.query(
    `UPDATE portal.outbox SET "leaseUntil"=now()-interval '1 second',version=version+1 WHERE "companyId"=$1 AND id=$2`,
    [companyId, eventId]
  );
}
function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("authenticates the scheduler and checks database readiness without leasing work", async () => {
  const captured = await capturedIntake();
  const process = vi.fn<SchedulerRuntime["process"]>();
  const runtime = scheduler(process);
  const handler = createCloudSchedulerHandler(
    configuration,
    runtime,
    verifiedService
  );
  expect((await handler(request("check"))).status).toBe(200);
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 0,
    leaseOwner: null,
    delivered: false
  });
  expect(process).not.toHaveBeenCalled();
  expect((await handler(request("drain", { headers: {} }))).status).toBe(401);
  expect(
    (
      await handler(
        request("drain", {
          headers: { authorization: "Bearer invalid.payload.signature" }
        })
      )
    ).status
  ).toBe(401);
  const wrongSubject = createCloudSchedulerHandler(configuration, runtime, {
    async verifyServiceToken(token, audience) {
      return {
        ...(await verifiedService.verifyServiceToken(token, audience)),
        sub: "100000000000000000004"
      };
    }
  });
  expect((await wrongSubject(request())).status).toBe(401);
  expect(
    (
      await handler(
        request("drain", { body: JSON.stringify({ companyId: "company-b" }) })
      )
    ).status
  ).toBe(400);
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 0,
    leaseOwner: null,
    delivered: false
  });
  expect(process).not.toHaveBeenCalled();
});

it("allows only one concurrent delivery and commits one extraction generation", async () => {
  const captured = await capturedIntake();
  const gate = latch();
  const parse = vi.fn(async () => {
    await gate.promise;
    return parsedDocument();
  });
  const handler = createCloudSchedulerHandler(
    configuration,
    scheduler((actor, event, signal) =>
      processPortalOutbox(processor(parse), actor, event, signal)
    ),
    verifiedService
  );
  const first = handler(request());
  try {
    await vi.waitFor(() => expect(parse).toHaveBeenCalledOnce());
    const concurrent = await handler(request());
    expect(concurrent.status).toBe(200);
    expect(await concurrent.json()).toEqual({ delivered: 0, invalidated: 0 });
    expect(await outbox(captured.eventId)).toMatchObject({
      attempts: 1,
      delivered: false
    });
  } finally {
    gate.release();
  }
  expect((await first).status).toBe(200);
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "needs-review",
    generation: "2",
    extractions: 1
  });
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 1,
    delivered: true,
    leaseOwner: null
  });
  expect((await handler(request())).status).toBe(200);
  expect(parse).toHaveBeenCalledOnce();
});

it("recovers a committed extraction after lost acknowledgment without parsing twice", async () => {
  const captured = await capturedIntake();
  const parse = vi.fn(async () => parsedDocument());
  let loseAcknowledgment = true;
  const handler = createCloudSchedulerHandler(
    configuration,
    scheduler(async (actor, event, signal) => {
      await processPortalOutbox(processor(parse), actor, event, signal);
      if (loseAcknowledgment) {
        loseAcknowledgment = false;
        await admin.query(
          `UPDATE portal.outbox SET "leaseOwner"='synthetic-replacement',version=version+1 WHERE "companyId"=$1 AND id=$2`,
          [companyId, event.id]
        );
      }
    }),
    verifiedService
  );
  expect((await handler(request())).status).toBe(503);
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "needs-review",
    generation: "2",
    extractions: 1
  });
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 1,
    delivered: false
  });
  expect(await (await handler(request())).json()).toEqual({
    delivered: 0,
    invalidated: 0
  });
  await expireLease(captured.eventId);
  const retried = await handler(request());
  expect(retried.status).toBe(200);
  expect(await retried.json()).toEqual({ delivered: 1, invalidated: 0 });
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 2,
    delivered: true,
    leaseOwner: null
  });
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "needs-review",
    generation: "2",
    extractions: 1
  });
  expect(parse).toHaveBeenCalledOnce();
});

it("retains failed parser work until lease expiry then successfully retries", async () => {
  const captured = await capturedIntake();
  let fail = true;
  const parse = vi.fn(async () => {
    if (fail) throw Error("Synthetic parser interruption");
    return parsedDocument();
  });
  const handler = createCloudSchedulerHandler(
    configuration,
    scheduler((actor, event, signal) =>
      processPortalOutbox(processor(parse), actor, event, signal)
    ),
    verifiedService
  );
  expect((await handler(request())).status).toBe(503);
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "captured",
    generation: "1",
    extractions: 0
  });
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 1,
    delivered: false
  });
  expect(await (await handler(request())).json()).toEqual({
    delivered: 0,
    invalidated: 0
  });
  fail = false;
  await expireLease(captured.eventId);
  expect((await handler(request())).status).toBe(200);
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "needs-review",
    generation: "2",
    extractions: 1
  });
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 2,
    delivered: true
  });
  expect(parse).toHaveBeenCalledTimes(2);
});

it("aborts an HTTP-triggered extraction before persistence and recovers on the next eligible delivery", async () => {
  const captured = await capturedIntake();
  const abort = new AbortController();
  let cancel = true;
  const parse = vi.fn(async () => {
    if (cancel) abort.abort();
    return parsedDocument();
  });
  const handler = createCloudSchedulerHandler(
    configuration,
    scheduler((actor, event, signal) =>
      processPortalOutbox(processor(parse), actor, event, signal)
    ),
    verifiedService
  );
  expect(
    (await handler(request("drain", { signal: abort.signal }))).status
  ).toBe(503);
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "captured",
    generation: "1",
    extractions: 0
  });
  expect(await outbox(captured.eventId)).toMatchObject({
    attempts: 1,
    delivered: false
  });
  cancel = false;
  await expireLease(captured.eventId);
  expect((await handler(request())).status).toBe(200);
  expect(await intakeState(captured.intakeId)).toEqual({
    state: "needs-review",
    generation: "2",
    extractions: 1
  });
});

it("invalidates source permissions before extraction and drains only one intake per request", async () => {
  const first = await capturedIntake();
  const second = await capturedIntake();
  const aclEventId = `acl-${randomUUID()}`;
  await admin.query(
    `INSERT INTO portal.outbox(id,"companyId","createdBy","sourceId","entityType","entityId","sourceVersion","eventType") VALUES ($1,$2,'alice',$3,'source',$3,'2','acl-change')`,
    [aclEventId, companyId, sourceId]
  );
  const before = await admin.query<{ epoch: string }>(
    `SELECT "aclEpoch"::text AS epoch FROM portal.source WHERE "companyId"=$1 AND id=$2`,
    [companyId, sourceId]
  );
  const parse = vi.fn(async () => {
    const after = await admin.query<{ epoch: string }>(
      `SELECT "aclEpoch"::text AS epoch FROM portal.source WHERE "companyId"=$1 AND id=$2`,
      [companyId, sourceId]
    );
    expect(BigInt(after.rows[0]!.epoch)).toBeGreaterThan(
      BigInt(before.rows[0]!.epoch)
    );
    expect((await outbox(aclEventId)).delivered).toBe(true);
    return parsedDocument();
  });
  const handler = createCloudSchedulerHandler(
    configuration,
    scheduler((actor, event, signal) =>
      processPortalOutbox(processor(parse), actor, event, signal)
    ),
    verifiedService
  );
  const response = await handler(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ delivered: 1, invalidated: 1 });
  const states = await Promise.all([
    outbox(first.eventId),
    outbox(second.eventId)
  ]);
  expect(states.filter((state) => state.delivered)).toHaveLength(1);
  expect(states.filter((state) => state.attempts === 0)).toHaveLength(1);
  expect(parse).toHaveBeenCalledOnce();
  expect((await handler(request())).status).toBe(200);
  expect(parse).toHaveBeenCalledTimes(2);
});
