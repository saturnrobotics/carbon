type Claims = Record<string, unknown> & {
  role: "anon" | "authenticated" | "service_role";
};

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function decodeObject(value: string): Record<string, unknown> {
  const decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("Invalid JWT object");
  }
  return decoded;
}

/** Verify before passing a token to Carbon functions, some of which decode it. */
export async function verifySupabaseJwt(
  authorization: string | null,
  secret: string,
  nowSeconds: number
): Promise<Claims | null> {
  if (!secret || !Number.isFinite(nowSeconds)) return null;
  const match = authorization?.match(
    /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i
  );
  if (!match) return null;

  try {
    const [, headerPart, payloadPart, signaturePart] = match;
    const header = decodeObject(headerPart);
    // This deployment uses an HMAC key. Do not accept caller-selected algorithms,
    // key locations, unsigned tokens, or unsupported critical JWT extensions.
    if (header.alg !== "HS256" || header.crit !== undefined) return null;

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      decodeBase64Url(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`)
    );
    if (!valid) return null;

    const claims = decodeObject(payloadPart);
    if (
      typeof claims.exp !== "number" ||
      !Number.isFinite(claims.exp) ||
      claims.exp <= nowSeconds ||
      (claims.nbf !== undefined &&
        (typeof claims.nbf !== "number" ||
          !Number.isFinite(claims.nbf) ||
          claims.nbf > nowSeconds))
    ) {
      return null;
    }
    if (
      claims.role !== "anon" &&
      claims.role !== "authenticated" &&
      claims.role !== "service_role"
    ) {
      return null;
    }
    if (
      claims.role === "authenticated" &&
      (typeof claims.sub !== "string" ||
        !claims.sub ||
        claims.is_anonymous === true)
    ) {
      return null;
    }
    return claims as Claims;
  } catch {
    return null;
  }
}
