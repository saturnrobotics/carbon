## Verify effective container arguments and final context exclusions

**Context:** Local container validation used a third-party storage emulator and a tooling allow-list in `.dockerignore`.

**Problem:** Compose `command` did not replace seed-loading arguments baked into the image entrypoint, so storage restart reassigned immutable generations. A later Docker context allow-list also overrode earlier exclusions for private local files.

**Rule:** Inspect effective container `Path`/`Args`, not only Compose `command`, when startup behavior matters. Override the entrypoint explicitly when removing baked arguments. Put private-path exclusions after broad re-inclusions and prove them with synthetic files through an actual Docker build.

**Applies to:** Persistent emulators, immutable object references, Docker build contexts and local deployment configuration.
