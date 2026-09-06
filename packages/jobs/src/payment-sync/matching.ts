import { parseAbsolute } from "@internationalized/date";
import type { PaymentSource } from "./providers";

export type InvoiceAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
};

export type InvoiceCandidate = {
  mailbox: string;
  messageId: string;
  subject: string;
  from: string;
  date: string;
  text: string;
  attachments: InvoiceAttachment[];
  score: number;
  reasons: string[];
  suggestedVendor: { name: string; email: string | null };
};

/** Money comparisons use decimal strings, not binary floating-point arithmetic. */
export function normalizedAmount(value: string): string | null {
  const match = /^[+-]?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function isOutgoingPayment(payment: PaymentSource): boolean {
  return (
    payment.amount.startsWith("-") &&
    normalizedAmount(payment.amount) !== null &&
    normalizedAmount(payment.amount) !== "0" &&
    [
      "outgoingPayment",
      "debitCardTransaction",
      "creditCardTransaction"
    ].includes(payment.kind)
  );
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function parseSender(value: string): {
  name: string;
  email: string | null;
} {
  const email =
    value
      .match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]
      ?.toLowerCase() ?? null;
  const name = value
    .replace(/<[^>]*>/g, "")
    .replace(/^["']|["']$/g, "")
    .trim();
  return { name: name && name !== email ? name.slice(0, 200) : "", email };
}

/** Strip markup for text matching only; callers must never render this as HTML. */
export function plainEmailText(value: string): string {
  return value
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100_000);
}

function invoiceReferences(value: string): string[] {
  const matches = [
    ...value.matchAll(
      /\b(?:invoice|inv|bill)(?:\s*(?:number|no\.?|#|:))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,39})/gi
    )
  ];
  return [
    ...new Set(
      matches.map((match) => match[1]!).filter((ref) => /\d/.test(ref))
    )
  ];
}

function queryPhrase(value: string): string {
  // Provider-controlled values must not inject Gmail search operators.
  const safe = value
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}@.,_+-]+/gu, " ")
    .trim()
    .slice(0, 160);
  return safe ? `"${safe}"` : "";
}

/** Each query searches all retained mailbox history; no date cutoff is applied. */
export function buildInvoiceSearchQueries(payment: PaymentSource): string[] {
  const invoice = "{invoice receipt bill filename:pdf}";
  const queries = invoiceReferences(payment.note)
    .map(queryPhrase)
    .filter(Boolean);
  if (payment.email) queries.push(`${invoice} ${queryPhrase(payment.email)}`);
  if (normalize(payment.name).length >= 3)
    queries.push(`${invoice} ${queryPhrase(payment.name)}`);
  const amount = normalizedAmount(payment.amount);
  if (amount && amount !== "0") {
    const [whole, fraction = ""] = amount.split(".");
    const decimal = `${whole}.${fraction.padEnd(2, "0")}`;
    const grouped = `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction.padEnd(2, "0")}`;
    queries.push(
      `${invoice} {${queryPhrase(decimal)} ${queryPhrase(grouped)}}`
    );
  }
  return [...new Set(queries)].slice(0, 6);
}

function matchingMoney(
  text: string,
  amount: string,
  currency: string
): boolean {
  const expected = normalizedAmount(amount);
  if (!expected || !/^[A-Z]{3}$/.test(currency)) return false;
  const symbols: Record<string, string> = {
    USD: "US\\$|\\$",
    EUR: "€",
    GBP: "£"
  };
  const marker = `${currency}${symbols[currency] ? `|${symbols[currency]}` : ""}`;
  const number = "([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,3})?)";
  const pattern = new RegExp(
    `(?:\\b${currency}\\b|${symbols[currency] ?? "(?!)"})\\s*${number}(?![0-9.,])|(?<![0-9.,])${number}\\s*(?:${marker})(?![A-Z])`,
    "gi"
  );
  // '$' alone is ambiguous when the document explicitly names a different dollar currency.
  const conflictingDollar =
    currency === "USD" &&
    /\b(?:CAD|AUD|NZD|SGD|HKD)\b|(?:CA|C|AU|A|NZ|SG|HK)\$/i.test(text);
  // Prefer explicitly labelled totals so a coincidentally equal line item or
  // subtotal does not match a payment for a different invoice total.
  const totals = [
    ...text.matchAll(
      /\b(?:grand\s+total|invoice\s+total|amount\s+due|balance\s+due|total(?:\s+due)?)\s*[:=-]?\s*((?:(?:[A-Z]{3}|US\$|CA\$|AU\$|NZ\$|\$|€|£)\s*)?\d[\d,.]*(?:\s*[A-Z]{3}\b)?)/gi
    )
  ]
    .map((match) => match[1]!)
    .filter((total) => /\b[A-Z]{3}\b|[$€£]/i.test(total));
  for (const match of (totals.length ? totals.join("\n") : text).matchAll(
    pattern
  )) {
    if (conflictingDollar && !/\bUSD\b|US\$/i.test(match[0])) continue;
    if (
      normalizedAmount((match[1] ?? match[2] ?? "").replace(/,/g, "")) ===
      expected
    )
      return true;
  }
  return false;
}

function hasName(text: string, name: string): boolean {
  const needle = normalize(name)
    .replace(/\b(?:inc|llc|ltd|corp|corporation|limited)\b/g, "")
    .trim();
  return needle.length >= 4 && ` ${normalize(text)} `.includes(` ${needle} `);
}

const GENERIC_DOMAINS = new Set([
  "gmail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "aol.com",
  "proton.me",
  "protonmail.com"
]);

export function rankInvoiceCandidates(
  payment: PaymentSource,
  input: InvoiceCandidate[]
): {
  candidates: InvoiceCandidate[];
  best: InvoiceCandidate | null;
  ambiguous: boolean;
} {
  const candidates = input
    .map((candidate) => {
      const text = `${candidate.subject}\n${candidate.text}`;
      const sender = parseSender(candidate.from);
      const reasons: string[] = [];
      let score = 0;
      const moneyMatch = matchingMoney(text, payment.amount, payment.currency);
      if (moneyMatch) {
        score += 45;
        reasons.push("Exact amount and currency");
      }
      const references = invoiceReferences(payment.note);
      const referenceMatch = references.some((reference) =>
        ` ${normalize(text)} `.includes(` ${normalize(reference)} `)
      );
      if (referenceMatch) {
        score += 45;
        reasons.push("Invoice reference matches payment");
      }
      const exactEmail =
        !!payment.email && sender.email === payment.email.toLowerCase();
      const domain = payment.email?.split("@")[1]?.toLowerCase();
      const domainMatch =
        !!domain &&
        !GENERIC_DOMAINS.has(domain) &&
        domain === sender.email?.split("@")[1];
      const nameMatch = hasName(`${sender.name} ${text}`, payment.name);
      if (exactEmail) {
        score += 30;
        reasons.push("Recipient email matches sender");
      } else if (domainMatch) {
        score += 15;
        reasons.push("Recipient domain matches sender");
      }
      if (nameMatch) {
        score += 20;
        reasons.push("Vendor name matches");
      }
      const invoiceEvidence =
        /\b(invoice|receipt|bill)\b/i.test(text) ||
        candidate.attachments.some((attachment) =>
          /invoice|receipt|bill/i.test(attachment.fileName)
        );
      if (invoiceEvidence) {
        score += 5;
        reasons.push("Invoice document evidence");
      }
      try {
        const distance = Math.abs(
          parseAbsolute(candidate.date, "UTC").compare(
            parseAbsolute(payment.postedAt ?? payment.createdAt, "UTC")
          )
        );
        if (distance <= 45 * 86_400_000) {
          score += 5;
          reasons.push("Email date is near payment date");
        }
      } catch {
        /* Missing or malformed dates contribute no evidence. */
      }
      // Names and dates alone must never become an automatic match.
      const strong =
        invoiceEvidence &&
        (moneyMatch || referenceMatch) &&
        (exactEmail || domainMatch || nameMatch);
      if (!strong) score = Math.min(score, 59);
      return {
        ...candidate,
        score,
        reasons,
        suggestedVendor: {
          name: nameMatch ? payment.name : sender.name || payment.name,
          // Forwarded invoices often have an employee as the envelope sender.
          // Bank recipient metadata is stronger evidence than the forwarding header.
          email:
            payment.email ??
            (sender.email?.split("@")[1] !== candidate.mailbox.split("@")[1]
              ? sender.email
              : null)
        }
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.messageId.localeCompare(b.messageId) ||
        a.mailbox.localeCompare(b.mailbox)
    );
  const first = candidates[0];
  // Similar evidence in two messages is deliberately left for review, including forwarded copies.
  const ambiguous =
    !!first &&
    first.score >= 75 &&
    !!candidates[1] &&
    first.score - candidates[1].score < 15;
  return {
    candidates,
    best: first && first.score >= 75 && !ambiguous ? first : null,
    ambiguous
  };
}
