## Generated-ID proposal forms must retain the complete item contract

**Context:** Reusing a native Material form as a proposal inside invoice review.

**Problem:** The normal generated-ID validator returns only material naming and taxonomy fields. Passing that result into a deferred item proposal silently drops tracking, purchasing method, replenishment, and unit fields displayed in the form.

**Rule:** In proposal mode, validate the full item contract together with the generated-ID requirements. Verify the saved proposal and the final approval, since a successful form submit alone does not prove the proposal contains the data required by the transactional creator.

**Applies to:** Generated material IDs and other native forms reused for deferred master creation.
