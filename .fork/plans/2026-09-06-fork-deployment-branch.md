# Local deployment from the integration branch

- [x] Inspect the committed deployment, private configuration boundaries, and Git remotes.
- [x] Create `saturn/main` preserving existing fork changes and fetch upstream.
- [x] Add feature/merge/upstream helpers and deployment branch enforcement without changing root files.
- [x] Publish the exact reviewed deployment commit automatically and report source-check failures clearly.
- [x] Verify isolated Git workflows, deployment tests, and private configuration.
- [ ] Commit the reviewed changes, integrate the latest upstream, and run `make deploy` locally.
- [ ] Verify private HTTPS, application dependencies, and Google-only access settings on the deployed server.

Use merges for the shared integration branch. Keep root documentation and existing
Makefile unchanged; put operator instructions and implementation in the deployment
directory. No cloud project IDs, domains, addresses, credentials, or production logs
belong in tracked source. Deployment requires a clean integration branch, checks
that the latest upstream is included, publishes only that committed branch without
force, and transfers its source archive separately from private configuration.

Verification: 40 deployment, renderer, and isolated Git workflow tests passed;
ShellCheck passed for both workflow entry points; private configuration validation
and whitespace checks passed. Publication review found no private configuration
or credentials in the outgoing changes. No TypeScript or schema changes were made.
