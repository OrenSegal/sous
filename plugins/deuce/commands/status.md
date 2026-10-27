---
description: List every local branch and whether it is stale (merged and ready to clean up), kept, or held back; read-only
argument-hint: "[--base NAME] [--remote NAME] [--repo DIR]"
allowed-tools: Bash(deuce status), Bash(deuce status --json)
---

Show which branches are stale with `deuce status`. Arguments: `$ARGUMENTS`

1. Run `deuce status` with any `--base`, `--remote` or `--repo` from the arguments. It only reads. If the shell says `deuce` is not found, run `"${CLAUDE_PLUGIN_ROOT}/bin/deuce"` with the same arguments instead.
2. Report the table: stale branches (merged, would be swept), held ones (merged, but a safety rule stops the sweep, with the reason), and the rest. Mention worktrees by path.
3. If there are stale branches, say that `/deuce:sweep` shows the dry run of the cleanup. Do not run a sweep, and never pass `--apply`, from this command.
