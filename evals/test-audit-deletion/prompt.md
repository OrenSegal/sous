---
name: test-audit-deletion
description: Asked whether to delete a flaky test file, the agent finds it is the only test of cache expiry and the flake is a real-clock sleep, and proposes a fix instead of a deletion.
tags: [core, skills]
plugins: ["../.."]
runs: 3
expected_outcome: The agent reads tests/test_cache.py and src/cache.py, says expiry is tested nowhere else, blames the sleep on a real clock, and proposes injecting a fake clock rather than deleting the file.
model: sonnet
max_turns: 8
timeout_seconds: 240
allowed_tools: [Read, Glob, Grep, Skill]
---

`tests/test_cache.py` is flaky and nobody owns it. Clean up the tests: tell me whether we should just delete that file.
