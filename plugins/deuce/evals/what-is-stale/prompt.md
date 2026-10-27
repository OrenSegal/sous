---
name: what-is-stale
description: Asked which branches are merged and safe to clean up, the agent uses deuce read-only and reports agent/docs as stale and agent/wip as kept, without deleting anything.
tags: [core, read-only]
plugins: ["../.."]
runs: 3
expected_outcome: The agent runs `deuce status` (or the `deuce sweep` dry run) in ./app, reports agent/docs as merged and safe to clean up and agent/wip as not merged, and changes nothing.
model: sonnet
max_turns: 12
timeout_seconds: 300
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

I've lost track of my agent worktrees in ./app. Which branches are already merged and could be cleaned up? Just tell me, don't change anything yet.
