# Preserve the intended identity through PostgreSQL TLS upgrades

**Context:** A PostgreSQL URL uses verify-full and an IP-only certificate SAN.

**Problem:** pg omits TLS servername for IP addresses when upgrading a socket.
Without an explicit TLS host, Node checks localhost. URL TLS parameters can also
replace caller-provided SSL options during pg connection parsing.

**Rule:** All production Portal pools use `portalPoolConfig` from
`@carbon/portal/database.server` (relative import within the package). Preserve
CA and hostname/IP verification; never bypass certificate checks. Audit schema,
query, worker, retention, and operator connections together. Test the real pg TLS
upgrade with ephemeral certificates, including wrong-host and untrusted-CA cases.
Mocked pool configuration and a successful libpq connection do not prove Node's
TLS identity behavior. Keep generated keys outside tracked files.

Run handshake regressions on the deployed Node major version. Node 22.23.2 has
[a separate IPv6 SAN verifier regression](https://github.com/nodejs/node/issues/64144)
that fails closed. The current deployment contract requires private IPv4;
normalizing a bracketed IPv6 URL does not prove IPv6 runtime support.

**Applies to:** Portal PostgreSQL pools and future database client upgrades.
