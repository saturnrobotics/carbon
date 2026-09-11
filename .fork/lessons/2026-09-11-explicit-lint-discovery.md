# Explicit authored-file lint discovery

**Context:** An upstream MCP server change passed an expanded scoped check but
failed the committed CI gate because the root Biome config excludes that path.

**Problem:** Git selected 363 authored files while Biome silently checked 362.
No lint diagnostic identified the missing file; the count assertion correctly
refused to call the partial check successful.

**Rule:** Filter generated outputs through the reviewed registry, then lint every
explicit authored path with expanded discovery and inherited lint rules. Keep the
checked-file count assertion. Test the real committed-file command with a valid
excluded MCP server and an invalid server that must fail.

**Applies to:** Fork lint gates and future upstream changes to Biome discovery.
