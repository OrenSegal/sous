---
description: List every worktree of this repo with its branch, state, tests, blocks and claims
argument-hint: "[--base REF]"
allowed-tools: Bash(sous fleet:*)
---

Run `sous fleet $ARGUMENTS` in the project root and show the table. Point out worktrees
that are dirty, far behind, have no test log, or have guard blocks. It is read-only; do
not prune, remove or switch worktrees unless the user asks.
