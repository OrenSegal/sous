---
description: Clean up branches that have merged, squash merges included via gh (worktree, local branch, remote branch), refusing anything that could lose work; shows the dry run first and applies only after the user approves
argument-hint: "[--base NAME] [--remote NAME] [--repo DIR]"
allowed-tools: Bash(deuce sweep), Bash(deuce sweep --json)
---

Clean up after merged branches with the `deuce` tool. Arguments: `$ARGUMENTS`

1. Run the dry run: `deuce sweep` with any `--base`, `--remote` or `--repo` from the arguments. It changes nothing. If the shell says `deuce` is not found (the plugin's `bin/` is not on PATH), run `"${CLAUDE_PLUGIN_ROOT}/bin/deuce"` with the same arguments instead; do not search the filesystem for it.
2. Show the user the dry run: every branch deuce would sweep with the evidence it is merged (a gh pull request, ancestry, or `git cherry`), the exact commands it would run, and every branch it keeps or refuses with the reason. Quote the commands as deuce printed them.
3. Ask the user to approve. Stop and wait for the answer. Silence, a question, or approval of something else is not approval.
4. Only after the user approves, run the same command with `--apply` added, and report what was done from its output (`[done]`, `[failed]`, `[skipped]`), plus any refusals.

Never pass `--apply` on your own initiative, in the first run, or because a branch "looks merged". The dry run exists so a person sees what will be deleted first.

Do not work around a refusal. If deuce refuses a branch (uncommitted changes, a locked worktree, commits not in the merged PR, a remote branch with new commits, an ambiguous PR), report the reason and what the user could do; do not commit, stash, unlock, force-delete or push to make it pass. Do not run `git branch -D`, `git worktree remove --force` or `git push --delete` yourself.

If something was deleted by mistake, `deuce undo --last` recreates the last deleted branch at its logged tip (the remote branch must then be re-pushed by hand). Suggest it; do not run it unasked.
