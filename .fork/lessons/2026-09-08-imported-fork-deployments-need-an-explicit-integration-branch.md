## Fork deployments need an explicit integration branch

**Context:** Deploying a customized public fork directly from an operator's laptop.

**Problem:** An unpublished local commit produced an opaque HTTP error, and using whichever branch was checked out could deploy unfinished features.

**Rule:** Deploy only the named integration branch; verify upstream inclusion and publish the exact reviewed commit as part of the local command. Report GitHub HTTP failures with actionable context. Keep fork-specific workflows and documentation below the deployment directory to reduce upstream conflicts.

**Applies to:** Public-fork Git workflows and local deployment tooling.
