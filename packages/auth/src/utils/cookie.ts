export function getCookieDomain(
  domain: string | null | undefined
): string | undefined {
  if (!domain) return undefined;

  const withoutProtocol = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "");
  const host = withoutProtocol.split("/")[0]?.split(":")[0];

  if (!host) return undefined;
  if (host === "localhost" || host.endsWith(".localhost")) return undefined;
  if (host.startsWith("[") || /^[\d.]+$/.test(host)) return undefined;

  return host;
}

export function shouldUseSecureCookie(
  domain: string | null | undefined,
  nodeEnv: string | null | undefined = process.env.NODE_ENV
): boolean {
  return nodeEnv === "production" || getCookieDomain(domain) !== undefined;
}
