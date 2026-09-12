import type { VerifiedWorkforceIdentity } from "@carbon/knowledge/identity.server";
import type { RetrievedChunk } from "@carbon/knowledge/retrieval/lexical.server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadAuthorization } from "./cache.server";
import { createDriveAccessChecker } from "./drive-access.server";
import { createProviderDisclosure } from "./query.server";

const identity: VerifiedWorkforceIdentity = {
  principal: {
    kind: "human",
    actorId: "alice",
    companyId: "company-a",
    callerId: "query",
    sourceIdentity: {
      issuer: "https://cloud.google.com/iap",
      subject: "subject-a"
    },
    policyVersion: "1",
    capabilities: ["knowledge.read"]
  },
  companyGroupId: "company-a",
  allowedOperations: ["knowledge.query"],
  accessLevels: []
};

function chunk(id: string, sourceKind: string): RetrievedChunk {
  return {
    id,
    documentId: `doc-${id}`,
    documentVersionId: `ver-${id}`,
    sourceId: "source-drive",
    sourceKind,
    sourceRevision: "1",
    sourceItemId: `file-${id}`,
    text: "Torque to 10 N m",
    title: "Manual",
    heading: null,
    page: 1,
    tokenCount: 5,
    classification: "internal",
    providerPolicy: {
      allowedProviders: ["vertex"],
      allowedClassifications: ["internal"]
    },
    aclVersion: "1",
    observedAt: "2026-09-11T00:00:00.000Z"
  };
}

const request = () =>
  new Request("https://query.example.com/v1/query", {
    headers: {
      authorization: "Bearer service",
      "x-portal-user-evidence": "assertion"
    }
  });

vi.mock("@carbon/knowledge/identity.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@carbon/knowledge/identity.server")
  >()),
  createWorkforceForwardingHeaders: async () =>
    new Headers({ authorization: "Bearer forwarded" })
}));

describe("createDriveAccessChecker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks the ingestion service with the reader's forwarded evidence and denies on anything but success", async () => {
    const fetchImpl = vi.fn<
      (input: URL | string | Request, init?: RequestInit) => Promise<Response>
    >(async (input) => {
      const url = new URL(String(input));
      return new Response(null, {
        status: url.pathname.includes("file-allowed") ? 204 : 403
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const check = createDriveAccessChecker({
      request: request(),
      identity,
      workerOrigin: "https://worker.example.com/",
      workerAudience: "worker"
    });
    await expect(check(chunk("allowed", "drive"))).resolves.toBe(true);
    await expect(check(chunk("revoked", "drive"))).resolves.toBe(false);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://worker.example.com/v1/drive/source-drive/documents/file-allowed/access"
    );
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error"
    });
    // Ordinary sources never consult Drive.
    await expect(check(chunk("upload", "upload"))).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed without a configured worker, on a non-HTTPS worker, and when the worker is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("unreachable");
      })
    );
    await expect(
      createDriveAccessChecker({ request: request(), identity })(
        chunk("a", "drive")
      )
    ).resolves.toBe(false);
    await expect(
      createDriveAccessChecker({
        request: request(),
        identity,
        workerOrigin: "http://worker.internal/",
        workerAudience: "worker"
      })(chunk("a", "drive"))
    ).resolves.toBe(false);
    await expect(
      createDriveAccessChecker({
        request: request(),
        identity,
        workerOrigin: "https://worker.example.com/",
        workerAudience: "worker"
      })(chunk("a", "drive"))
    ).resolves.toBe(false);
  });
});

describe("Drive revocation before provider disclosure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a candidate batch, and never calls the answer model, once the live Drive check turns to deny", async () => {
    let allowed = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: allowed ? 204 : 403 }))
    );
    const candidates = [chunk("a", "drive"), chunk("b", "drive")];
    const answer = vi.fn(async () => ({ claims: [] }));
    // One authorization surface per request, exactly as the query handler
    // builds it: the checker's short memo never outlives the request.
    const disclosureForRequest = () => {
      const liveAccess = createDriveAccessChecker({
        request: request(),
        identity,
        workerOrigin: "https://worker.example.com/",
        workerAudience: "worker"
      });
      const { authorizedCandidates } = createReadAuthorization({
        read: async (operation) =>
          operation({
            query: async () => ({ rows: candidates, rowCount: 2 })
          } as never),
        principal: identity.principal,
        identityStore: {
          resolveHuman: async () => ({
            actorId: "alice",
            canonicalUserId: "alice",
            bindingActive: true,
            userActive: true,
            membershipActive: true,
            capabilities: ["knowledge.read"],
            revocationVersion: "1",
            permissionsVersion: "1"
          })
        } as never,
        sourceIds: ["source-drive"],
        signal: new AbortController().signal,
        trace: { measure: async (_stage, run) => run() },
        liveAccess
      });
      return createProviderDisclosure({
        providerId: "vertex",
        trace: {
          record: () => undefined,
          measure: async (_stage, run) => run()
        },
        authorizedCandidates,
        answer
      });
    };
    const evidence = candidates.map((candidate) => ({
      id: candidate.id,
      documentId: candidate.documentId,
      documentVersionId: candidate.documentVersionId,
      sourceId: candidate.sourceId,
      sourceRevision: candidate.sourceRevision,
      title: candidate.title,
      snippet: candidate.text,
      link: "https://portal.example.com/doc",
      policyVersion: "1",
      observedAt: candidate.observedAt
    }));
    const queryRequest = {
      requestId: "request_synthetic",
      text: "what torque does the manual specify",
      mode: "answer" as const,
      locale: "en-US"
    };
    await disclosureForRequest()(
      queryRequest as never,
      evidence as never,
      new AbortController().signal
    );
    expect(answer).toHaveBeenCalledTimes(1);

    // The folder permission changed: the live check now denies both chunks.
    allowed = false;
    await expect(
      disclosureForRequest()(
        queryRequest as never,
        evidence as never,
        new AbortController().signal
      )
    ).rejects.toThrow("Authorization changed");
    expect(answer).toHaveBeenCalledTimes(1);
  });
});
