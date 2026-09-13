export const PORTAL_TEST_DATABASE_URL = "PORTAL_TEST_DATABASE_URL";
export const PORTAL_TEST_DATABASE_DISPOSABLE =
  "PORTAL_TEST_DATABASE_DISPOSABLE";

const expectedDatabaseName = "portal_test";
const allowedLocalHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const privilegedUsers = new Set(["postgres", "supabase_admin"]);

function refuse(): never {
  throw new Error(
    "Expected an explicitly marked disposable local portal test database"
  );
}

export function assertDisposableLocalDatabaseUrl(
  value: string | undefined,
  disposableMarker: string | undefined
): URL {
  if (!value || disposableMarker !== "1") refuse();

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refuse();
  }

  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !allowedLocalHosts.has(parsed.hostname) ||
    !parsed.port ||
    parsed.port === "5432" ||
    databaseName !== expectedDatabaseName ||
    !parsed.username ||
    privilegedUsers.has(decodeURIComponent(parsed.username)) ||
    parsed.searchParams.has("host") ||
    parsed.searchParams.has("port")
  ) {
    return refuse();
  }

  return parsed;
}

export function getDisposableLocalDatabaseUrl(
  environment: Record<string, string | undefined> = process.env
): string {
  const value = environment[PORTAL_TEST_DATABASE_URL];
  assertDisposableLocalDatabaseUrl(
    value,
    environment[PORTAL_TEST_DATABASE_DISPOSABLE]
  );
  return value as string;
}
