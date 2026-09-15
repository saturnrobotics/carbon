# Exercise the full callback URL against the authentication provider

Context → MES login preserves the requested page in the callback query string.

Problem → The shared authentication provider allowlisted the bare MES callback, rejected the callback with redirectTo, and silently fell back to the ERP site URL. A configured MES origin and healthy login page did not prove the round trip.

Rule → Test the complete callback URL produced by each login entry against the pinned production provider image. Allow required query values only after an exact trusted origin, callback path, literal question mark, and expected parameter name. Keep foreign hosts, lookalike hosts, alternate schemes, and adjacent paths outside the allowlist. OAuth cancellation can prove destination selection without real accounts or external sign-in.

Applies to → Self-hosted ERP/MES OAuth callback allowlists and deployment integration checks.
