# Preserve generation evidence

Context → An upstream integration left conflict markers in the committed MCP digest while installation regenerated a valid working copy.

Problem → Inspecting only the working copy or a clean build concealed the corrupt commit. Generator subprocess failure could also truncate last-good DB types.

Rule → Inspect the Git commit/index before installation. Resolve authored inputs, generate with pinned tools, compare against that immutable snapshot, and repeat the entire generator pipeline. Stage reviewed output explicitly. Publish generated files only after successful generation and validation; failed commands preserve last-good output. Exercise these failure paths in CI.

Applies to → Every tracked generated contract and every upstream integration. See `.fork/verify.py`, `.fork/generated-artifacts.json`, and the generator failure fixtures.
