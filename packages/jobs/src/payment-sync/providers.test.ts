import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  extractPdfText,
  GmailClient,
  type GmailMailboxConfig,
  MercuryClient,
  type PaymentSource,
  ProviderError
} from "./providers";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const rawPayment = {
  id: "payment-1",
  accountId: "account-1",
  counterpartyId: "recipient-1",
  counterpartyName: "Example Parts",
  amount: -1234.5,
  status: "sent",
  kind: "outgoingPayment",
  createdAt: "2026-09-05T00:00:00Z",
  postedAt: null,
  note: "Invoice INV-987",
  attachments: [
    {
      fileName: "invoice.pdf",
      url: "https://files.s3.us-east-1.amazonaws.com/document.pdf?signature=first",
      attachmentType: "receipt"
    }
  ]
};
const payment: PaymentSource = {
  id: "payment-1",
  accountId: "account-1",
  recipientId: "recipient-1",
  name: "Example Parts",
  email: "billing@parts.example.com",
  amount: "-1234.50",
  currency: "USD",
  status: "sent",
  kind: "outgoingPayment",
  postedAt: null,
  createdAt: "2026-09-05T00:00:00Z",
  note: "Invoice INV-987",
  attachments: []
};
const config: GmailMailboxConfig = {
  email: "invoices@example.com",
  clientId: "synthetic-client",
  clientSecret: "synthetic-secret",
  refreshToken: "synthetic-refresh",
  enabled: true
};
const toBase64 = (value: string) => Buffer.from(value).toString("base64url");

describe("read-only Mercury client", () => {
  it("propagates a stopped sync before making provider requests", async () => {
    const paused = Object.assign(new Error("stopped"), {
      name: "PaymentSyncPaused"
    });
    const fetcher = vi.fn<typeof fetch>();
    const client = new MercuryClient("token", {
      fetch: fetcher,
      beforeRequest: async () => {
        throw paused;
      }
    });
    await expect(client.listTransactions()).rejects.toBe(paused);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("uses documented page cursors, preserves sign and statuses, and starts without a cutoff", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ transactions: [rawPayment], page: { nextPage: "cursor-1" } })
      )
      .mockResolvedValueOnce(
        json({
          transactions: [{ ...rawPayment, status: "reversed" }],
          page: {}
        })
      );
    const client = new MercuryClient("synthetic-bank-token", {
      fetch: fetcher
    });
    const first = await client.listTransactions();
    expect(first.payments[0]).toMatchObject({
      amount: "-1234.50",
      currency: "USD",
      recipientId: "recipient-1",
      status: "sent"
    });
    expect(
      new URL(String(fetcher.mock.calls[0]![0])).searchParams.has("start")
    ).toBe(false);
    const second = await client.listTransactions({
      startAfter: first.nextPage!
    });
    expect(
      new URL(String(fetcher.mock.calls[1]![0])).searchParams.get("start_after")
    ).toBe("cursor-1");
    expect(second.payments[0]?.status).toBe("reversed");
    expect(second.nextPage).toBeNull();
    expect(
      fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET"
      )
    ).toBe(true);
  });
  it("uses the same attachment ID when a signed URL refreshes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(rawPayment))
      .mockResolvedValueOnce(
        json({
          ...rawPayment,
          attachments: [
            {
              ...rawPayment.attachments[0],
              url: "https://files.s3.us-east-1.amazonaws.com/document.pdf?signature=second"
            }
          ]
        })
      );
    const client = new MercuryClient("token", { fetch: fetcher });
    expect((await client.getTransaction("payment-1")).attachments[0]?.id).toBe(
      (await client.getTransaction("payment-1")).attachments[0]?.id
    );
  });
  it("reads recipient contact metadata without retaining bank routing details", async () => {
    const client = new MercuryClient("token", {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        json({
          id: "recipient-1",
          name: "Example Parts",
          contactEmail: "billing@example.com",
          emails: ["invoices@example.com"],
          electronicRoutingInfo: { accountNumber: "synthetic-routing" }
        })
      )
    });
    expect(await client.getRecipient("recipient-1")).toEqual({
      id: "recipient-1",
      name: "Example Parts",
      email: "billing@example.com",
      emails: ["invoices@example.com"]
    });
  });
  it("pages events for status/attachment changes without applying untrusted patches", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        events: [
          {
            id: "event-1",
            resourceId: "payment-1",
            resourceType: "transaction",
            operationType: "update",
            occurredAt: "2026-09-06T00:00:00Z",
            mergePatch: { status: "reversed" }
          }
        ],
        page: { nextPage: "event-next" }
      })
    );
    const result = await new MercuryClient("token", {
      fetch: fetcher
    }).listEvents({ startAfter: "event-before" });
    expect(result.events[0]).not.toHaveProperty("mergePatch");
    expect(result.nextPage).toBe("event-next");
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "resourceType=transaction"
    );
  });
  it("never forwards a bank token to signed attachments, and refuses redirects", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("%PDF-content"));
    const checkUrl = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      url: new URL(url)
    }));
    const client = new MercuryClient("synthetic-bank-token", {
      fetch: fetcher,
      checkUrl
    });
    await client.downloadAttachment({
      id: "attachment",
      fileName: "invoice.pdf",
      url: rawPayment.attachments[0]!.url
    });
    expect(fetcher.mock.calls[0]![1]?.headers).toBeUndefined();
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  });
  it("blocks nonapproved hosts, private DNS, and oversized streamed attachments", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const client = new MercuryClient("token", {
      fetch: fetcher,
      checkUrl: async () => ({ ok: false, reason: "private" })
    });
    for (const url of [
      "http://files.s3.amazonaws.com/a",
      "https://metadata.google.internal/a",
      "https://files.s3.amazonaws.com.attacker.example/a",
      "https://user:pass@files.s3.amazonaws.com/a",
      "https://files.s3.amazonaws.com/a"
    ]) {
      await expect(
        client.downloadAttachment({ id: "a", fileName: "a", url })
      ).rejects.toBeInstanceOf(ProviderError);
    }
    expect(fetcher).not.toHaveBeenCalled();
    const large = new MercuryClient("token", {
      fetch: async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1)),
      checkUrl: async (url) => ({ ok: true, url: new URL(url) })
    });
    await expect(
      large.downloadAttachment({
        id: "a",
        fileName: "a",
        url: "https://files.s3.amazonaws.com/a"
      })
    ).rejects.toThrow("response_too_large");
  });
  it("redacts response bodies, signed URLs and network errors", async () => {
    const client = new MercuryClient("token", {
      fetch: async () => json({ error: "sensitive-provider-body" }, 403)
    });
    await expect(client.listTransactions()).rejects.toThrow(
      "Mercury: request_failed (HTTP 403)"
    );
    const broken = new MercuryClient("token", {
      fetch: async () => {
        throw new Error("sensitive-network-url");
      }
    });
    await expect(broken.listTransactions()).rejects.toThrow(
      "Mercury: connection_failed"
    );
  });
});

describe("Gmail invoice access", () => {
  it("propagates a stop during PDF download instead of swallowing it as optional extraction failure", async () => {
    const paused = Object.assign(new Error("stopped"), {
      name: "PaymentSyncPaused"
    });
    let stop = false;
    let attachmentRequests = 0;
    const fetcher: typeof fetch = async (url) => {
      const value = String(url);
      if (value.endsWith("/token")) return json({ access_token: "token" });
      if (value.endsWith("/profile"))
        return json({ emailAddress: config.email });
      if (value.includes("/attachments/")) {
        attachmentRequests++;
        return json({ data: toBase64("%PDF-content") });
      }
      if (value.includes("?format=full")) {
        stop = true;
        return json({
          id: "message",
          payload: {
            mimeType: "multipart/mixed",
            parts: [
              {
                mimeType: "application/pdf",
                filename: "invoice.pdf",
                body: { attachmentId: "pdf", size: 20 }
              }
            ]
          }
        });
      }
      return json({ messages: [{ id: "message" }] });
    };
    const client = new GmailClient(config, {
      fetch: fetcher,
      beforeRequest: async () => {
        if (stop) throw paused;
      }
    });
    await expect(client.searchInvoices(payment)).rejects.toBe(paused);
    expect(attachmentRequests).toBe(0);
  });
  it("bounds parallel message downloads to four", async () => {
    let active = 0;
    let maximum = 0;
    const fetcher: typeof fetch = async (url) => {
      const value = String(url);
      if (value.endsWith("/token")) return json({ access_token: "token" });
      if (value.endsWith("/profile"))
        return json({ emailAddress: config.email });
      if (value.includes("?format=full")) {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        active--;
        return json({
          id: value.split("/messages/")[1]!.split("?")[0],
          payload: {
            mimeType: "text/plain",
            body: { data: toBase64("Invoice") }
          }
        });
      }
      return json({
        messages: Array.from({ length: 12 }, (_, i) => ({ id: `mail-${i}` }))
      });
    };
    const result = await new GmailClient(config, {
      fetch: fetcher
    }).searchInvoices(payment);
    expect(result.candidates).toHaveLength(12);
    expect(maximum).toBe(4);
  });
  describe("real PDF extraction", () => {
    beforeAll(async () => {
      // Cold PDF.js worker initialization belongs to bounded fixture
      // setup. Keep the actual document extraction under the normal test limit.
      await import("@carbon/lib/shims");
      const { PDFWorker } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const worker = new PDFWorker();
      try {
        await worker.promise;
      } finally {
        worker.destroy();
      }
    });
    it("extracts actual PDF text locally without evaluating document instructions", async () => {
      const stream =
        "BT /F1 12 Tf 20 100 Td (Example Parts invoice total USD 1234.50) Tj ET";
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
      ];
      let pdf = "%PDF-1.4\n";
      const offsets = [0];
      for (const [index, object] of objects.entries()) {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
      }
      const xref = Buffer.byteLength(pdf);
      pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          ""
        )}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      expect(await extractPdfText(new TextEncoder().encode(pdf))).toContain(
        "Example Parts invoice total USD 1234.50"
      );
    });
  });
  it("retains inline MIME invoice attachments for later private storage", async () => {
    const inline = {
      id: "inline-message",
      internalDate: "1788652800000",
      payload: {
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "application/pdf",
            filename: "invoice.pdf",
            body: { data: toBase64("%PDF-inline-content") }
          }
        ]
      }
    };
    const fetcher: typeof fetch = async (url) =>
      json(
        String(url).endsWith("/token")
          ? { access_token: "token" }
          : String(url).endsWith("/profile")
            ? { emailAddress: config.email }
            : String(url).includes("/messages/inline-message")
              ? inline
              : { messages: [{ id: "inline-message" }] }
      );
    const client = new GmailClient(config, {
      fetch: fetcher,
      extractPdf: async () => "Inline invoice total USD 1,234.50"
    });
    const result = await client.searchInvoices(payment);
    const candidate = result.candidates[0]!;
    expect(candidate.attachments[0]?.id).toBe("inline:0");
    expect(candidate.text).toContain("USD 1,234.50");
    expect(
      new TextDecoder().decode(
        await client.getAttachment(candidate, candidate.attachments[0]!)
      )
    ).toBe("%PDF-inline-content");
  });
  it("reports incomplete searches when result bounds apply", async () => {
    const fetcher: typeof fetch = async (url) => {
      const value = String(url);
      if (value.endsWith("/token")) return json({ access_token: "token" });
      if (value.endsWith("/profile"))
        return json({ emailAddress: config.email });
      if (value.includes("?format=full"))
        return json({
          id: "mail",
          payload: {
            mimeType: "text/plain",
            body: { data: toBase64("Invoice") }
          }
        });
      const start = new URL(value).searchParams.has("pageToken") ? 100 : 0;
      return json({
        messages: Array.from({ length: 100 }, (_, i) => ({
          id: `mail-${start + i}`
        })),
        nextPageToken: `page-${start + 100}`
      });
    };
    const result = await new GmailClient(config, {
      fetch: fetcher
    }).searchInvoices(payment);
    expect(result.truncated).toBe(true);
    expect(result.candidates).toHaveLength(200);
  });
  it("continues when an individual message was deleted", async () => {
    const fetcher: typeof fetch = async (url) => {
      const value = String(url);
      if (value.endsWith("/token")) return json({ access_token: "token" });
      if (value.endsWith("/profile"))
        return json({ emailAddress: config.email });
      if (value.includes("/messages/deleted")) return json({}, 404);
      if (value.includes("/messages/available"))
        return json({
          id: "available",
          payload: {
            mimeType: "text/plain",
            body: { data: toBase64("Invoice") }
          }
        });
      return json({ messages: [{ id: "deleted" }, { id: "available" }] });
    };
    const result = await new GmailClient(config, {
      fetch: fetcher
    }).searchInvoices(payment);
    expect(result.candidates.map((candidate) => candidate.messageId)).toEqual([
      "available"
    ]);
    expect(result.truncated).toBe(true);
  });
  it("refreshes a private token, verifies mailbox, paginates searches and extracts PDF evidence", async () => {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (raw, init) => {
      const url = new URL(String(raw));
      calls.push({ url, init });
      if (url.pathname === "/token")
        return json({ access_token: "synthetic-access", expires_in: 3600 });
      if (url.pathname.endsWith("/profile"))
        return json({ emailAddress: config.email });
      if (url.pathname.endsWith("/attachments/pdf-1"))
        return json({ data: toBase64("%PDF-content") });
      if (url.pathname.endsWith("/messages/message-1"))
        return json({
          id: "message-1",
          internalDate: "1788652800000",
          payload: {
            mimeType: "multipart/mixed",
            headers: [
              { name: "Subject", value: "Invoice INV-987" },
              {
                name: "From",
                value: "Example Parts <billing@parts.example.com>"
              }
            ],
            parts: [
              {
                mimeType: "text/plain",
                body: { data: toBase64("Please see attached invoice.") }
              },
              {
                mimeType: "application/pdf",
                filename: "invoice.pdf",
                body: { attachmentId: "pdf-1", size: 100 }
              }
            ]
          }
        });
      if (url.pathname.endsWith("/messages"))
        return json({
          messages: [{ id: "message-1" }],
          ...(url.searchParams.has("pageToken")
            ? {}
            : { nextPageToken: "next" })
        });
      throw new Error("unexpected call");
    };
    const client = new GmailClient(config, {
      fetch: fetcher,
      extractPdf: async () => "Example Parts Total USD 1,234.50"
    });
    const result = await client.searchInvoices(payment);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.text).toContain("USD 1,234.50");
    expect(result.candidates[0]?.attachments[0]?.id).toBe("pdf-1");
    await client.searchInvoices(payment);
    expect(
      calls.filter((call) => call.url.pathname.endsWith("/messages/message-1"))
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.url.pathname.endsWith("/attachments/pdf-1"))
    ).toHaveLength(1);
    expect(calls.filter((call) => call.url.pathname === "/token")).toHaveLength(
      1
    );
    expect(calls[0]?.init?.method).toBe("POST");
    expect(String(calls[0]?.init?.body)).toContain("grant_type=refresh_token");
    expect(
      calls
        .slice(1)
        .every((call) => !call.init?.method || call.init.method === "GET")
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.url.pathname.endsWith("/messages"))
        .every(
          (call) =>
            call.url.searchParams.get("includeSpamTrash") === "true" &&
            !/after:|before:|newer_than:/.test(
              call.url.searchParams.get("q") ?? ""
            )
        )
    ).toBe(true);
  });
  it("refuses disabled connections before fetching", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new GmailClient(
        { ...config, enabled: false },
        { fetch: fetcher }
      ).searchInvoices(payment)
    ).rejects.toThrow("disabled");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("checks that the authorized mailbox is the configured one", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: "token" }))
      .mockResolvedValueOnce(json({ emailAddress: "other@example.com" }));
    await expect(
      new GmailClient(config, { fetch: fetcher }).searchInvoices(payment)
    ).rejects.toThrow("mailbox_mismatch");
  });
  it("keeps credentials and errors isolated between mailbox clients", async () => {
    const failed = new GmailClient(config, {
      fetch: async () => json({ error: "private-details" }, 401)
    });
    const healthy = new GmailClient(
      { ...config, email: "purchasing@example.com" },
      {
        fetch: async (url) =>
          json(
            String(url).endsWith("/token")
              ? { access_token: "token" }
              : String(url).endsWith("/profile")
                ? { emailAddress: "purchasing@example.com" }
                : {}
          )
      }
    );
    const result = await Promise.allSettled([
      failed.searchInvoices(payment),
      healthy.searchInvoices(payment)
    ]);
    expect(result[0]?.status).toBe("rejected");
    expect(result[1]?.status).toBe("fulfilled");
    expect(
      result[0]?.status === "rejected" && String(result[0].reason)
    ).not.toContain("private-details");
  });
  it("detects repeated page cursors instead of looping forever", async () => {
    const fetcher: typeof fetch = async (url) =>
      json(
        String(url).endsWith("/token")
          ? { access_token: "token" }
          : String(url).endsWith("/profile")
            ? { emailAddress: config.email }
            : { messages: [], nextPageToken: "repeated" }
      );
    await expect(
      new GmailClient(config, { fetch: fetcher }).searchInvoices(payment)
    ).rejects.toThrow("invalid_pagination");
  });
});
