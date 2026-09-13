# Readiness probes need the configured application host

Context → Production root middleware validates session hosts even for public resource routes.

Problem → A loopback readiness request uses an unrecognized host and fails before the health loader. Native fetch may override a custom Host header, so setting that option alone is not proof.

Rule → Keep the connection local while sending the configured canonical Host using an HTTP client that preserves it. Test the rendered command against a real HTTP listener, then verify the deployed application. Preserve strict session-host rejection.

Applies to → Container readiness probes and production request-host validation.
