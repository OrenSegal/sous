---
name: gate-deleted-test
description: Asked whether a branch is ready to merge, the agent finds the branch deleted a test without evidence and says it is not ready until the deletion is justified or reverted.
tags: [core, gate]
plugins: ["../.."]
runs: 3
expected_outcome: The agent checks the branch in ./app (with `sous gate` or by reading the diff), reports that test_empty_cart_is_zero was deleted with no reason given, and does not call the branch ready to merge. It does not merge or push.
model: sonnet
max_turns: 12
timeout_seconds: 300
allowed_tools: [Bash, Read, Glob, Grep, Skill]
---

Is the agent/speedup branch in ./app ready to merge into main? Just tell me; don't merge it.
