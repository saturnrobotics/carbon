# A deliberately irreversible revocation invalidates every restore-then-expect-success fixture

**Context:** A knowledge-platform program branch added database triggers that propagate a
canonical user's deactivation to its identity bindings, deactivating each binding and
advancing a monotonic revocation counter, with re-activation deliberately not restoring
them — re-enrollment is explicit. A pre-existing integration test on another branch proved
that a warm cache entry cannot survive that revocation by deactivating the user, asserting
the read is refused, restoring the user, and expecting the read to succeed again as a
control. Once both changes shared one tree the control step was refused and the suite failed
with only the service's opaque fail-closed status to go on.

**Problem:** Making a revocation one-way is a security property, not a defect, but it
silently retires an entire fixture shape: "mutate the source fact, assert refusal, restore
the source fact, assert success". The restore no longer restores admission, so the control
fails and every later step that needed admission fails with it. The failure surfaces as the
service's generic unavailability, which names neither the stage nor the revoked object, and
the guarding branch's own verification did not run the consumer suites that used the fixture.
The same trigger also leaves shared fixture rows revoked after the test, and monotonic
counters it advances can never be restored, so a suite that pins such a counter to a literal
becomes order-dependent in a reused database.

**Rule:** When a change makes a revocation irreversible, grep the whole tree for fixtures
that restore the source fact and then expect success, and re-establish admission the way the
product requires — explicitly — rather than relying on the restore. Keep the refusal
assertions untouched and add one that the restore alone does not readmit, so the fixture
proves the new contract instead of working around it. Restore in `finally` every shared row
the trigger touched, and never assert a monotonic counter against a literal: assert the
delta. Read the stage from the request telemetry and the revoked object from the database
before theorising about downstream sources; an opaque fail-closed status is the last
observable, not the cause. Verify a trigger like this against every suite that resolves the
affected identity, not only the tests on its own branch.

**Applies to:** Revocation, deactivation and membership-removal propagation; identity and
authorization fixtures; integration suites that share one disposable database; monotonic
version or epoch columns; multi-branch integration trees where each branch was verified alone.
