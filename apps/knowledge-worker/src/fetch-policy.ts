import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const privateHosts = new Set(["localhost", "metadata.google.internal"]);

export function validateFetchUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:")
    throw new Error("Only HTTPS intake URLs are allowed");
  const hostname = url.hostname.toLowerCase();
  if (
    privateHosts.has(hostname) ||
    hostname === "::1" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^169\.254\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  )
    throw new Error("private network intake URLs are forbidden");
  return url;
}

function forbiddenAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  )
    return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped ?? (isIP(normalized) === 4 ? normalized : undefined);
  if (!ipv4) return false;
  return (
    /^127\./.test(ipv4) ||
    /^10\./.test(ipv4) ||
    /^192\.168\./.test(ipv4) ||
    /^169\.254\./.test(ipv4) ||
    /^0\./.test(ipv4) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ipv4)
  );
}

export async function fetchBoundedUrl(
  value: string,
  options: {
    fetchImpl?: typeof fetch;
    resolve?: (hostname: string) => Promise<readonly string[]>;
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
  } = {}
): Promise<{ bytes: Buffer; mimeType: string; finalUrl: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve =
    options.resolve ??
    (async (hostname) =>
      (await lookup(hostname, { all: true })).map((entry) => entry.address));
  const maximum = options.maxBytes ?? 50_000_000;
  let url = validateFetchUrl(value);
  for (
    let redirects = 0;
    redirects <= (options.maxRedirects ?? 3);
    redirects += 1
  ) {
    const addresses = await resolve(url.hostname);
    if (!addresses.length || addresses.some(forbiddenAddress))
      throw new Error("private network intake URLs are forbidden");
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 15_000
    );
    try {
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "application/pdf,image/*" }
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === (options.maxRedirects ?? 3))
          throw new Error("intake URL exceeded its redirect limit");
        url = validateFetchUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok || !response.body)
        throw new Error(`intake URL acquisition failed (${response.status})`);
      const mimeType =
        (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim() ??
        "";
      if (mimeType !== "application/pdf" && !mimeType.startsWith("image/"))
        throw new Error("unsupported intake content type");
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maximum)
        throw new Error("intake object exceeds the parser byte limit");
      const chunks: Uint8Array[] = [];
      let received = 0;
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > maximum)
          throw new Error("intake object exceeds the parser byte limit");
        chunks.push(chunk);
      }
      return {
        bytes: Buffer.concat(chunks),
        mimeType,
        finalUrl: url.toString()
      };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("intake URL exceeded its redirect limit");
}
