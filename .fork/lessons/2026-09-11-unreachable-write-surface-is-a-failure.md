# An unreachable check surface is a failed check, not an untested one

Context → The disposable OAuth evaluation probed Storage and Realtime right after
`docker compose up -d` returned. Both services listen only after their own
migrations and tenant seeding, so the mapped ports accepted and closed the
connection, and the two write-replay gates were recorded as `untested` for weeks
while the run still reported an exit code of 0.

Problem → A missing observation looked like a deliberate scope decision. Nothing
waited for the services, nothing distinguished "closed connection" from "not in
scope", and the adoption gate silently excluded two of its own write surfaces.

Rule → Give every container the probe depends on a healthcheck and wait on its
readiness endpoint before the first assertion, recording that readiness as its own
matrix row. When a request gets no HTTP response, record the check as `fail` with an
`unreachable:` observation so the gate cannot pass without evidence; reserve
`untested` for surfaces that need inputs the harness does not have (a real Firebase
project, a signing key). Prove a denial with a second read: a 403 plus a service-role
lookup that finds no object, not the status code alone.

Applies to → `contrib/deploying/gcp-tailscale/auth/oauth-evaluation/`, any compose-
backed harness whose gates depend on a service being reachable, and any evidence
matrix that carries an `untested` status.
