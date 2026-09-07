import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  review: vi.fn(),
  retry: vi.fn(),
  invoiceSettings: vi.fn(),
  mercurySettings: vi.fn(),
  worker: vi.fn(),
  provider: vi.fn(),
  download: vi.fn()
}));
vi.mock("../../../../../packages/jobs/src/db", () => ({
  getJobDatabaseClient: mocks.database
}));
vi.mock("../../../../../packages/jobs/src/invoice-intake/backfill", () => ({
  registerMercuryInvoiceSources: vi.fn()
}));
vi.mock("../../../../../packages/jobs/src/invoice-intake/provider", () => ({
  createGoogleInvoiceProvider: mocks.provider,
  loadInvoiceProviderConfig: () => ({ enabled: true, model: "example-model" })
}));
vi.mock("../../../../../packages/jobs/src/invoice-intake/validation", () => ({
  setInvoiceIntakeValidation: vi.fn()
}));
vi.mock("../../../../../packages/jobs/src/invoice-intake/worker", () => ({
  runInvoiceIntake: mocks.worker
}));
vi.mock("../../../../../packages/jobs/src/payment-sync/providers", () => ({
  MercuryClient: vi.fn()
}));
vi.mock("../../../../../packages/jobs/src/payment-sync/sync", () => ({
  refreshMercurySupportingDocuments: vi.fn()
}));
vi.mock("./invoicing.server", () => ({
  getInvoiceIntakePermissions: async () => ({
    canSettings: true,
    canUpdate: true
  }),
  getInvoiceIntakeReview: mocks.review,
  saveInvoiceIntakeSettings: mocks.invoiceSettings,
  setInvoiceIntakeStatus: mocks.retry,
  validateHydratedInvoiceIntake: vi.fn()
}));
vi.mock("./mercury.server", () => ({
  saveMercurySettings: mocks.mercurySettings
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: { from: () => ({ download: mocks.download }) }
  })
}));
const { runInvoiceOperator } = await import("./invoice-operator.server");
const { INVOICE_PROMPT_VERSION, INVOICE_SCHEMA_VERSION } = await import(
  "../../../../../packages/jobs/src/invoice-intake/contracts"
);
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = new TextEncoder().encode("synthetic receipt bytes");
let directory: string;
let intake: {
  id: string;
  companyId: string;
  generation: number;
  revision: number;
  status: string;
  activeExtractionId: string | null;
};
let checkpoint: {
  configHash: string;
  restoreRequired: boolean;
  completed: number[];
  baseline: string;
  inFlight?: { step: number; generation: number };
  original: {
    invoice: {
      enabled: boolean;
      automaticMercuryIntake: boolean;
      dailyBudgetUsd: number;
      monthlyBudgetUsd: number;
    };
    mercury: {
      enabled: boolean;
      gmailEnabled: boolean;
      disabledMailboxes: string[];
    };
  };
};
let config: Record<string, unknown>;
let updates: Array<{
  values: Record<string, unknown>;
  conditions: unknown[][];
}>;
beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), "invoice-operator-test-"));
  vi.stubEnv("INVOICE_OPERATOR_REVISION", "a".repeat(40));
  vi.stubEnv("INVOICE_OPERATOR_SCHEDULER_PAUSED", "true");
  intake = {
    id: "example-intake",
    companyId: "example-company",
    generation: 1,
    revision: 0,
    status: "Queued",
    activeExtractionId: null
  };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  config = {
    companyId: intake.companyId,
    userId: "example-user",
    requiredRevision: "a".repeat(40),
    identity: {
      modelId: "example-model",
      promptVersion: INVOICE_PROMPT_VERSION,
      schemaVersion: INVOICE_SCHEMA_VERSION
    },
    maxNewExtractions: 1,
    steps: [
      { action: "parse", intakeId: intake.id, expectedRevision: 0, sha256 }
    ]
  };
  checkpoint = {
    configHash: digest(config),
    restoreRequired: false,
    completed: [],
    baseline: "example-baseline",
    original: {
      invoice: {
        enabled: true,
        automaticMercuryIntake: true,
        dailyBudgetUsd: 10,
        monthlyBudgetUsd: 100
      },
      mercury: { enabled: true, gmailEnabled: false, disabledMailboxes: [] }
    }
  };
  const source = {
    id: "example-source",
    kind: "upload",
    storagePath: "example/source.pdf",
    mimeType: "application/pdf",
    sha256
  };
  mocks.review.mockImplementation(async () => ({
    intake: { ...intake },
    sources: [source],
    review: {
      header: { excludedLines: [], sourceAcknowledgements: [] },
      lines: []
    }
  }));
  mocks.download.mockResolvedValue({ data: new Blob([bytes]), error: null });
  mocks.retry.mockImplementation(async () => {
    intake.generation++;
    intake.revision++;
    intake.status = "Queued";
  });
  mocks.worker.mockResolvedValue({ state: "retry" });
  updates = [];
  mocks.database.mockReturnValue({
    destroy: vi.fn(),
    selectFrom: () => {
      const query = {
        selectAll: () => query,
        where: () => query,
        execute: async () => []
      };
      return query;
    },
    updateTable: () => {
      const conditions: unknown[][] = [];
      let values: Record<string, unknown> = {};
      const query = {
        set: (value: Record<string, unknown>) => {
          values = value;
          return query;
        },
        where: (...condition: unknown[]) => {
          conditions.push(condition);
          return query;
        },
        execute: async () => {
          updates.push({ values, conditions });
          if (
            conditions.every(([key, op, expected]) =>
              op === "in"
                ? (expected as unknown[]).includes(
                    intake[key as keyof typeof intake]
                  )
                : intake[key as keyof typeof intake] === expected
            )
          )
            Object.assign(intake, { ...values, revision: intake.revision + 1 });
          return [];
        }
      };
      return query;
    }
  });
  await saveInputs();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function saveInputs() {
  for (const [name, value] of [
    ["operator", config],
    ["checkpoint", checkpoint],
    ["check", { configHash: checkpoint.configHash }]
  ] as const)
    await writeFile(
      path.join(directory, `${name}.json`),
      JSON.stringify(value),
      { mode: 0o600 }
    );
}
describe("invoice operator interruption lifecycle", () => {
  it("disarms a worker retry before restoring scheduling and never repeats paid admission", async () => {
    mocks.invoiceSettings.mockImplementation(async (_db, _actor, settings) => {
      if (settings.automaticMercuryIntake)
        expect(intake.status).toBe("NeedsReview");
    });
    await expect(runInvoiceOperator(directory, "apply")).rejects.toThrow(
      "Extraction needs inspection"
    );
    expect(mocks.worker).toHaveBeenCalledTimes(1);
    expect(intake.status).toBe("NeedsReview");
    expect(updates[0].conditions).toEqual(
      expect.arrayContaining([
        ["companyId", "=", config.companyId],
        ["id", "=", intake.id],
        ["generation", "=", 1],
        ["status", "in", ["Queued", "Processing"]]
      ])
    );
    expect(mocks.invoiceSettings.mock.calls.at(-1)?.[2]).toEqual(
      checkpoint.original.invoice
    );
    const saved = JSON.parse(
      await readFile(path.join(directory, "checkpoint.json"), "utf8")
    );
    expect(saved.restoreRequired).toBe(false);
    expect(saved.inFlight).toEqual({ step: 0, generation: 1 });
    await expect(runInvoiceOperator(directory, "apply")).rejects.toThrow(
      /admission|interrupted/i
    );
    expect(mocks.worker).toHaveBeenCalledTimes(1);
  });
  it("records admission before queue preparation so interruption cannot orphan runnable work", async () => {
    intake.status = "NeedsReview";
    mocks.retry.mockImplementation(async () => {
      const saved = JSON.parse(
        await readFile(path.join(directory, "checkpoint.json"), "utf8")
      );
      expect(saved.inFlight).toEqual({ step: 0, generation: 2 });
      intake.generation = 2;
      intake.status = "Queued";
      throw new Error("synthetic interruption after queue write");
    });
    await expect(runInvoiceOperator(directory, "apply")).rejects.toThrow(
      "synthetic interruption"
    );
    expect(intake.status).toBe("NeedsReview");
    expect(mocks.worker).not.toHaveBeenCalled();
  });
  it("recovers settings after deployment without rewriting manifest identity", async () => {
    checkpoint.restoreRequired = true;
    checkpoint.inFlight = { step: 0, generation: 1 };
    await saveInputs();
    vi.stubEnv("INVOICE_OPERATOR_REVISION", "b".repeat(40));
    await runInvoiceOperator(directory, "recover");
    expect(intake.status).toBe("NeedsReview");
    expect(mocks.worker).not.toHaveBeenCalled();
    expect(mocks.invoiceSettings).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      checkpoint.original.invoice
    );
    expect(
      JSON.parse(await readFile(path.join(directory, "operator.json"), "utf8"))
    ).toEqual(config);
    expect(
      JSON.parse(
        await readFile(path.join(directory, "checkpoint.json"), "utf8")
      )
    ).toMatchObject({
      configHash: checkpoint.configHash,
      restoreRequired: false
    });
    await expect(runInvoiceOperator(directory, "apply")).rejects.toThrow(
      "Deployed revision mismatch"
    );
  });
  it("does not overwrite a newer generation during recovery", async () => {
    checkpoint.restoreRequired = true;
    checkpoint.inFlight = { step: 0, generation: 1 };
    await saveInputs();
    intake.generation = 2;
    await runInvoiceOperator(directory, "recover");
    expect(intake.status).toBe("Queued");
    expect(intake.revision).toBe(0);
    expect(mocks.worker).not.toHaveBeenCalled();
  });
  it("retains recoverability when restoring settings fails", async () => {
    checkpoint.restoreRequired = true;
    checkpoint.inFlight = { step: 0, generation: 1 };
    await saveInputs();
    mocks.invoiceSettings.mockRejectedValueOnce(
      new Error("synthetic settings failure")
    );
    await expect(runInvoiceOperator(directory, "recover")).rejects.toThrow(
      "synthetic settings failure"
    );
    expect(intake.status).toBe("NeedsReview");
    expect(
      JSON.parse(
        await readFile(path.join(directory, "checkpoint.json"), "utf8")
      ).restoreRequired
    ).toBe(true);
    await runInvoiceOperator(directory, "recover");
    expect(
      JSON.parse(
        await readFile(path.join(directory, "checkpoint.json"), "utf8")
      ).restoreRequired
    ).toBe(false);
    expect(mocks.worker).not.toHaveBeenCalled();
  });
  it("still rejects changed manifests during recover after deployment", async () => {
    checkpoint.restoreRequired = true;
    config.requiredRevision = "b".repeat(40);
    await saveInputs();
    vi.stubEnv("INVOICE_OPERATOR_REVISION", "b".repeat(40));
    await expect(runInvoiceOperator(directory, "recover")).rejects.toThrow(
      "Checkpoint belongs to another manifest"
    );
    expect(mocks.invoiceSettings).not.toHaveBeenCalled();
    expect(mocks.worker).not.toHaveBeenCalled();
  });
});
