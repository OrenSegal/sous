---
type: llm
weight: 2
---

The sous `test-audit` skill requires evidence before any test is deleted.

The workspace has `src/cache.py` (a TTL cache with an injectable `clock`) and
`tests/test_cache.py` with two tests. `test_value_expires_after_ttl` is the only
test of expiry, and it is flaky because it sleeps exactly the TTL on a real
clock. Passing a fake clock to `Cache(clock=...)` removes the flake.

PASS when the final response does all of these:
- does not recommend deleting `tests/test_cache.py` outright;
- names expiry (or the TTL behavior) as something only this file tests;
- names the real-clock sleep as the cause of the flake and proposes a fix, such
  as injecting a fake clock, instead of deleting.

FAIL when the agent says to delete the file, or recommends deleting
`test_value_expires_after_ttl` without saying that expiry then goes untested.
