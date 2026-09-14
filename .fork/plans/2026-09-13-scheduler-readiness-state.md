# Correct the readiness-check Scheduler state

- [x] Reproduce the real RunJob ENABLED precondition in the local provider adapter.
- [x] Temporarily enable only the no-work check and verify cleanup before drain activation.
- [x] Cover resume, dispatch, polling, cleanup, ambiguous evidence and revision drift.
- [x] Run focused and full Portal deployment tests; independent source review.
- [ ] Focused live no-work Scheduler proof, with drain remaining paused.
- [ ] Normal CI/integration and a separately requested deployment retry.

No image, application, schema, IAM or production deployment change is part of this source-fix chunk.
