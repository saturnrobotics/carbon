import { createHash } from "node:crypto";
import { fromAbsolute } from "@internationalized/date";
import { fetch as undiciFetch } from "undici";
import {
  checkOutboundUrl,
  outboundDispatcher
} from "../workflows/actions/url-guard";
import {
  buildInvoiceSearchQueries,
  type InvoiceAttachment,
  type InvoiceCandidate,
  parseSender,
  plainEmailText
} from "./matching";

export type SourceAttachment = { id: string; fileName: string; url: string };
export type PaymentSource = {
  id: string;
  accountId: string;
  recipientId: string | null;
  name: string;
  email: string | null;
  /** Signed bank amount. Mercury's transaction amount is denominated in USD. */
  amount: string;
  currency: string;
  status: string;
  kind: string;
  postedAt: string | null;
  createdAt: string;
  note: string;
  attachments: SourceAttachment[];
  hasGeneratedReceipt?: boolean | null;
};
export type GmailMailboxConfig = {
  email: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  enabled: boolean;
};
export type ProviderOptions = {
  fetch?: typeof globalThis.fetch;
  checkUrl?: typeof checkOutboundUrl;
  extractPdf?: (bytes: Uint8Array) => Promise<string>;
  beforeRequest?: () => Promise<void>;
};
export type InvoiceSearchResult = {
  candidates: InvoiceCandidate[];
  truncated: boolean;
};
export type MercuryEvent = {
  id: string;
  resourceId: string;
  resourceType: string;
  operationType: string;
  occurredAt: string;
};

const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MAX_JSON = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const MERCURY = "https://api.mercury.com/api/v1";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export class ProviderError extends Error {
  constructor(
    public readonly provider: "Mercury" | "Gmail" | "Attachment",
    public readonly code: string,
    public readonly status?: number
  ) {
    super(`${provider}: ${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "ProviderError";
  }
}

function propagatePause(error: unknown): void {
  if (error instanceof Error && error.name === "PaymentSyncPaused") throw error;
}

function record(
  value: unknown,
  provider: "Mercury" | "Gmail"
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderError(provider, "invalid_response");
  return value as Record<string, unknown>;
}
function string(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function required(value: unknown, provider: "Mercury" | "Gmail"): string {
  if (typeof value !== "string" || !value || value.length > 100_000)
    throw new ProviderError(provider, "invalid_response");
  return value;
}
function array(value: unknown, provider: "Mercury" | "Gmail"): unknown[] {
  if (!Array.isArray(value))
    throw new ProviderError(provider, "invalid_response");
  return value;
}
function fileName(value: unknown): string {
  return (
    string(value, "attachment")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Remove unsafe control characters from provider filenames.
      .replace(/[\x00-\x1f\x7f/\\]/g, "_")
      .slice(0, 200)
  );
}

async function bytes(
  response: Response,
  max: number,
  provider: "Mercury" | "Gmail" | "Attachment"
): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new ProviderError(provider, "response_too_large");
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new ProviderError(provider, "response_too_large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

class HttpClient {
  readonly fetcher: typeof globalThis.fetch;
  constructor(readonly options: ProviderOptions = {}) {
    this.fetcher =
      options.fetch ??
      (async (url, init) =>
        (await undiciFetch(String(url), {
          ...init,
          dispatcher: outboundDispatcher
        } as Parameters<typeof undiciFetch>[1])) as unknown as Response);
  }
  async request(
    url: string,
    provider: "Mercury" | "Gmail" | "Attachment",
    init: RequestInit = {}
  ): Promise<Response> {
    // The worker's control signal is intentionally outside provider error handling.
    await this.options.beforeRequest?.();
    try {
      const response = await this.fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(provider, "request_failed", response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(provider, "connection_failed");
    }
  }
  async json(
    url: string,
    provider: "Mercury" | "Gmail",
    init: RequestInit = {}
  ): Promise<Record<string, unknown>> {
    try {
      return record(
        JSON.parse(
          new TextDecoder().decode(
            await bytes(
              await this.request(url, provider, init),
              MAX_JSON,
              provider
            )
          )
        ),
        provider
      );
    } catch (error) {
      propagatePause(error);
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(provider, "invalid_response");
    }
  }
}

function bankAmount(value: unknown): string {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > Number.MAX_SAFE_INTEGER / 100 ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.0001
  )
    throw new ProviderError("Mercury", "invalid_amount");
  return value.toFixed(2);
}

function payment(raw: unknown): PaymentSource {
  const data = record(raw, "Mercury");
  const attachments = array(data.attachments ?? [], "Mercury").map(
    (rawAttachment) => {
      const attachment = record(rawAttachment, "Mercury");
      const name = fileName(attachment.fileName);
      const url = required(attachment.url, "Mercury");
      let stableUrl: string;
      try {
        const parsed = new URL(url);
        stableUrl = `${parsed.origin}${parsed.pathname}`;
      } catch {
        throw new ProviderError("Mercury", "invalid_attachment");
      }
      return {
        id: createHash("sha256").update(`${name}\n${stableUrl}`).digest("hex"),
        fileName: name,
        url
      };
    }
  );
  return {
    id: required(data.id, "Mercury"),
    accountId: required(data.accountId, "Mercury"),
    recipientId: string(data.counterpartyId) || null,
    name: string(data.counterpartyName).slice(0, 200),
    email: null,
    amount: bankAmount(data.amount),
    currency: "USD",
    status: required(data.status, "Mercury"),
    kind: required(data.kind, "Mercury"),
    postedAt: string(data.postedAt) || null,
    createdAt: required(data.createdAt, "Mercury"),
    note: [
      string(data.note),
      string(data.externalMemo),
      string(data.bankDescription)
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 10_000),
    attachments,
    hasGeneratedReceipt:
      typeof data.hasGeneratedReceipt === "boolean"
        ? data.hasGeneratedReceipt
        : null
  };
}

export class MercuryClient extends HttpClient {
  constructor(
    private readonly token: string,
    options: ProviderOptions = {}
  ) {
    super(options);
  }
  private get(path: string): Promise<Record<string, unknown>> {
    return this.json(`${MERCURY}${path}`, "Mercury", {
      headers: { Authorization: `Bearer ${this.token}` }
    });
  }
  async listTransactions(
    options: { startAfter?: string; start?: string; limit?: number } = {}
  ): Promise<{ payments: PaymentSource[]; nextPage: string | null }> {
    const query = new URLSearchParams({
      order: "asc",
      limit: String(Math.max(1, Math.min(1000, options.limit ?? 100)))
    });
    if (options.startAfter) query.set("start_after", options.startAfter);
    if (options.start) query.set("start", options.start);
    const data = await this.get(`/transactions?${query}`);
    return {
      payments: array(data.transactions, "Mercury").map(payment),
      nextPage: string(record(data.page, "Mercury").nextPage) || null
    };
  }
  async getTransaction(id: string): Promise<PaymentSource> {
    return payment(await this.get(`/transaction/${encodeURIComponent(id)}`));
  }
  async getRecipient(id: string): Promise<{
    id: string;
    name: string;
    email: string | null;
    emails: string[];
  }> {
    const data = await this.get(`/recipient/${encodeURIComponent(id)}`);
    const emails = array(data.emails ?? [], "Mercury").filter(
      (value): value is string => typeof value === "string"
    );
    return {
      id: required(data.id, "Mercury"),
      name: string(data.name).slice(0, 200),
      email: string(data.contactEmail) || emails[0] || null,
      emails
    };
  }
  async listEvents(
    options: { startAfter?: string; limit?: number } = {}
  ): Promise<{ events: MercuryEvent[]; nextPage: string | null }> {
    const query = new URLSearchParams({
      order: "asc",
      limit: String(Math.max(1, Math.min(1000, options.limit ?? 100))),
      resourceType: "transaction"
    });
    if (options.startAfter) query.set("start_after", options.startAfter);
    const data = await this.get(`/events?${query}`);
    return {
      events: array(data.events, "Mercury").map((raw) => {
        const event = record(raw, "Mercury");
        return {
          id: required(event.id, "Mercury"),
          resourceId: required(event.resourceId, "Mercury"),
          resourceType: required(event.resourceType, "Mercury"),
          operationType: required(event.operationType, "Mercury"),
          occurredAt: required(event.occurredAt, "Mercury")
        };
      }),
      nextPage: string(record(data.page, "Mercury").nextPage) || null
    };
  }
  async downloadAttachment(attachment: SourceAttachment): Promise<Uint8Array> {
    let url: URL;
    try {
      url = new URL(attachment.url);
    } catch {
      throw new ProviderError("Attachment", "invalid_url");
    }
    const allowedHost =
      /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(
        url.hostname
      );
    if (
      !allowedHost ||
      url.protocol !== "https:" ||
      (url.port && url.port !== "443") ||
      url.username ||
      url.password
    )
      throw new ProviderError("Attachment", "unapproved_host");
    const verdict = await (this.options.checkUrl ?? checkOutboundUrl)(url.href);
    if (!verdict.ok)
      throw new ProviderError("Attachment", "unapproved_address");
    // Signed object URLs authenticate themselves. Never forward the bank token.
    try {
      return await bytes(
        await this.request(url.href, "Attachment"),
        MAX_ATTACHMENT,
        "Attachment"
      );
    } catch (error) {
      propagatePause(error);
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("Attachment", "download_failed");
    }
  }
}

function decodeBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length > MAX_JSON ||
    !/^[A-Za-z0-9_-]*={0,2}$/.test(value)
  )
    throw new ProviderError("Gmail", "invalid_attachment");
  const result = new Uint8Array(Buffer.from(value, "base64url"));
  if (result.byteLength > MAX_ATTACHMENT)
    throw new ProviderError("Gmail", "response_too_large");
  return result;
}

export async function extractPdfText(data: Uint8Array): Promise<string> {
  if (
    data.byteLength > MAX_ATTACHMENT ||
    new TextDecoder().decode(data.slice(0, 5)) !== "%PDF-"
  )
    return "";
  let document:
    | {
        numPages: number;
        getPage: (
          page: number
        ) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
        destroy: () => Promise<void>;
      }
    | undefined;
  try {
    await import("@carbon/lib/shims");
    // @ts-ignore the legacy PDF.js bundle has no declaration file.
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    // @ts-ignore preload the worker for bundled server runtimes.
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    document = await pdfjs.getDocument({
      data: data.slice(),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true
    }).promise;
    if (!document || document.numPages > 50) return "";
    let text = "";
    for (let i = 1; i <= document.numPages && text.length < 100_000; i++) {
      const content = await (await document.getPage(i)).getTextContent();
      text += `${content.items.map((item) => (item && typeof item === "object" && "str" in item && typeof item.str === "string" ? item.str : "")).join(" ")}\n`;
    }
    return text.slice(0, 100_000);
  } catch {
    return "";
  } finally {
    await document?.destroy().catch(() => undefined);
  }
}

export class GmailClient extends HttpClient {
  private token = "";
  private expires = 0;
  private verified = false;
  private readonly messageCache = new Map<string, Promise<InvoiceCandidate>>();
  constructor(
    readonly config: GmailMailboxConfig,
    options: ProviderOptions = {}
  ) {
    super(options);
  }
  private async accessToken(): Promise<string> {
    if (!this.config.enabled) throw new ProviderError("Gmail", "disabled");
    if (this.token && performance.now() < this.expires) return this.token;
    const data = await this.json(
      "https://oauth2.googleapis.com/token",
      "Gmail",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          refresh_token: this.config.refreshToken
        })
      }
    );
    this.token = required(data.access_token, "Gmail");
    this.expires =
      performance.now() +
      Math.max(
        0,
        (typeof data.expires_in === "number" ? data.expires_in : 3600) - 60
      ) *
        1000;
    return this.token;
  }
  private async get(path: string): Promise<Record<string, unknown>> {
    return await this.json(`${GMAIL}${path}`, "Gmail", {
      headers: { Authorization: `Bearer ${await this.accessToken()}` }
    });
  }
  async getProfile(): Promise<{ email: string }> {
    const profile = await this.get("/profile");
    const email = required(profile.emailAddress, "Gmail").toLowerCase();
    if (email !== this.config.email.toLowerCase())
      throw new ProviderError("Gmail", "mailbox_mismatch");
    this.verified = true;
    return { email };
  }
  async getAttachment(
    candidate: Pick<InvoiceCandidate, "mailbox" | "messageId">,
    attachment: InvoiceAttachment
  ): Promise<Uint8Array> {
    if (candidate.mailbox.toLowerCase() !== this.config.email.toLowerCase())
      throw new ProviderError("Gmail", "mailbox_mismatch");
    if (!this.verified) await this.getProfile();
    if (attachment.size > MAX_ATTACHMENT)
      throw new ProviderError("Gmail", "response_too_large");
    if (attachment.id.startsWith("inline:")) {
      const path = attachment.id.slice(7);
      if (!/^(?:\d+(?:\.\d+)*)?$/.test(path))
        throw new ProviderError("Gmail", "invalid_attachment");
      const message = await this.get(
        `/messages/${encodeURIComponent(candidate.messageId)}?format=full`
      );
      let part = record(message.payload, "Gmail");
      for (const index of path ? path.split(".").map(Number) : []) {
        part = record(array(part.parts, "Gmail")[index], "Gmail");
      }
      return decodeBase64(record(part.body, "Gmail").data);
    }
    const data = await this.get(
      `/messages/${encodeURIComponent(candidate.messageId)}/attachments/${encodeURIComponent(attachment.id)}`
    );
    return decodeBase64(data.data);
  }
  private message(id: string): Promise<InvoiceCandidate> {
    const cached = this.messageCache.get(id);
    if (cached) return cached;
    // Cache only decoded text and attachment metadata; never retain PDF buffers.
    if (this.messageCache.size >= 200)
      this.messageCache.delete(this.messageCache.keys().next().value!);
    const result = this.readMessage(id).catch((error: unknown) => {
      this.messageCache.delete(id);
      throw error;
    });
    this.messageCache.set(id, result);
    return result;
  }
  private async readMessage(id: string): Promise<InvoiceCandidate> {
    const data = await this.get(
      `/messages/${encodeURIComponent(id)}?format=full`
    );
    const payload = record(data.payload, "Gmail");
    const headers = new Map(
      array(payload.headers ?? [], "Gmail").map((raw) => {
        const header = record(raw, "Gmail");
        return [string(header.name).toLowerCase(), string(header.value)];
      })
    );
    const texts: string[] = [];
    const attachments: InvoiceAttachment[] = [];
    let partCount = 0;
    const walk = (raw: unknown, path: number[] = []) => {
      if (path.length > 12 || ++partCount > 200)
        throw new ProviderError("Gmail", "message_too_complex");
      const part = record(raw, "Gmail");
      const body = record(part.body ?? {}, "Gmail");
      const mime = string(part.mimeType);
      const name = fileName(part.filename);
      if (string(part.filename) && string(body.attachmentId))
        attachments.push({
          id: string(body.attachmentId),
          fileName: name,
          mimeType: mime,
          size: typeof body.size === "number" ? body.size : 0
        });
      else if (string(body.data)) {
        const decoded = decodeBase64(body.data);
        if (mime === "text/plain")
          texts.push(new TextDecoder().decode(decoded).slice(0, 100_000));
        else if (mime === "text/html")
          texts.push(plainEmailText(new TextDecoder().decode(decoded)));
        else if (string(part.filename) || mime === "application/pdf")
          attachments.push({
            id: `inline:${path.join(".")}`,
            fileName: name,
            mimeType: mime,
            size: decoded.byteLength
          });
      }
      array(part.parts ?? [], "Gmail").forEach((child, index) => {
        walk(child, [...path, index]);
      });
    };
    walk(payload);
    const millis = Number(data.internalDate);
    const candidate: InvoiceCandidate = {
      mailbox: this.config.email.toLowerCase(),
      messageId: required(data.id, "Gmail"),
      subject: (headers.get("subject") ?? "").slice(0, 500),
      from: (headers.get("from") ?? "").slice(0, 500),
      date:
        Number.isFinite(millis) && millis > 0
          ? fromAbsolute(millis, "UTC").toAbsoluteString()
          : "",
      text: texts.join("\n").slice(0, 100_000),
      attachments,
      score: 0,
      reasons: [],
      suggestedVendor: parseSender(headers.get("from") ?? "")
    };
    const extract = this.options.extractPdf ?? extractPdfText;
    for (const attachment of attachments
      .filter(
        (item) =>
          item.mimeType === "application/pdf" || /\.pdf$/i.test(item.fileName)
      )
      .slice(0, 3)) {
      if (attachment.size > MAX_ATTACHMENT) continue;
      try {
        candidate.text += `\n${await extract(await this.getAttachment(candidate, attachment))}`;
      } catch (error) {
        propagatePause(error);
        /* An unreadable PDF remains available as review evidence. */
      }
    }
    candidate.text = candidate.text.slice(0, 100_000);
    return candidate;
  }
  async searchInvoices(payment: PaymentSource): Promise<InvoiceSearchResult> {
    if (!this.verified) await this.getProfile();
    const ids = new Set<string>();
    let truncated = false;
    for (const query of buildInvoiceSearchQueries(payment)) {
      let cursor = "";
      const seen = new Set<string>();
      do {
        const params = new URLSearchParams({
          q: query,
          maxResults: "100",
          includeSpamTrash: "true"
        });
        if (cursor) params.set("pageToken", cursor);
        const data = await this.get(`/messages?${params}`);
        for (const raw of array(data.messages ?? [], "Gmail")) {
          ids.add(required(record(raw, "Gmail").id, "Gmail"));
          if (ids.size >= 200) {
            truncated = true;
            break;
          }
        }
        cursor = string(data.nextPageToken);
        if (cursor && seen.has(cursor))
          throw new ProviderError("Gmail", "invalid_pagination");
        seen.add(cursor);
      } while (cursor && !truncated);
      if (truncated) break;
    }
    const messageIds = [...ids];
    const results: (InvoiceCandidate | undefined)[] = new Array(
      messageIds.length
    );
    let next = 0;
    const read = async () => {
      while (next < messageIds.length) {
        const index = next++;
        try {
          results[index] = await this.message(messageIds[index]!);
        } catch (error) {
          // One deleted or malformed email must not discard other invoice evidence.
          if (
            error instanceof ProviderError &&
            (error.status === 404 ||
              [
                "message_too_complex",
                "invalid_response",
                "invalid_attachment",
                "response_too_large"
              ].includes(error.code))
          ) {
            truncated = true;
            continue;
          }
          throw error;
        }
      }
    };
    // At most four messages (and their attachments) are being read at once.
    await Promise.all(
      Array.from({ length: Math.min(4, messageIds.length) }, read)
    );
    return {
      candidates: results.filter(
        (candidate): candidate is InvoiceCandidate => !!candidate
      ),
      truncated
    };
  }
}
