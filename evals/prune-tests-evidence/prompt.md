---
name: prune-tests-evidence
description: Asked to prune tests that guard nothing, the agent deletes the duplicate, the removed-code check and the test-only hook with its production helper, rewrites the formula-copying test, keeps the behavior tests, and writes one evidence line per deletion.
tags: [core, skills]
plugins: ["../.."]
runs: 3
expected_outcome: test_total_includes_tax, test_legacy_gone and test_reset_clears_cache are deleted, _reset_for_tests is removed from src/pricing.py, test_discount_formula asserts a literal, test_discount and test_total_with_tax are unchanged, and the response has one evidence line per deleted test.
model: sonnet
max_turns: 20
timeout_seconds: 420
allowed_tools: [Read, Glob, Grep, Edit, Write, Skill]
---

Prune the tests in tests/ that don't guard any behavior, then give me the PR description for the change.
