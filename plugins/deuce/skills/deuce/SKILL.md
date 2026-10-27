---
name: deuce
description: Use when the user wants to clean up after a merge - delete merged branches, prune worktrees, remove stale agent worktrees, or tidy a repository once pull requests have landed (including squash merges). Runs `deuce sweep` as a dry run, shows it, and applies only after the user approves.
license: MIT
---

# deuce

deuce is the second half of "merge, then tidy". After branches merge, it finds every local branch that is merged into the base branch and, for each one, removes its worktree (only if clean), deletes the local branch and deletes the remote branch. Then it fetches with `--prune`, fast-forwards the base branch and prunes stale worktree metadata.

It is built for people running many agent worktrees, where merged branches and their worktrees pile up. What it adds over `git branch --merged` and `git branch -d` is squash-merge detection through `gh`, plus refusals wherever a cleanup could lose work. Without `gh` it finds about what `git branch --merged` finds; if `gh` is missing or logged out, tell the user that multi-commit squash-merged branches will be kept as not merged.

## Workflow

1. Run the dry run: `deuce sweep` (add `--base NAME`, `--remote NAME` or `--repo DIR` if the user named them). It changes nothing. `deuce` is on the Bash tool's PATH while the plugin is enabled; if it is not found, run `"${CLAUDE_PLUGIN_ROOT}/bin/deuce"` instead. `deuce status` is the read-only overview if the user only asked what is stale.
2. Show the user the dry run: which branches would be swept and the evidence that each is merged, the exact commands, and which branches are kept or refused and why.
3. Ask for approval and wait. Only after the user approves, run the same command with `--apply`, then report what was done from its output.

Never pass `--apply` before the user has seen the dry run and approved it, and never in the same step as the dry run.

## How it decides a branch is merged

With `gh` installed and logged in, it asks GitHub for the branch's pull request (`gh pr list --head <branch>`). That is the only way to see a squash merge. Without `gh`, or with no PR, it checks whether the tip is an ancestor of `<remote>/<base>`, then `git cherry` (a rebase merge, or a one-commit squash). The report says which evidence it used. A multi-commit squash merge without `gh` is kept as "not merged": deuce does not guess.

The local branch is deleted with `git branch -d`. The force delete is used only when a squash-merged PR's head is exactly the branch tip.

## Refusals

A refused branch is left exactly as it is, and the exit code is 1. Report the reason; do not work around it (no committing, stashing, unlocking, `git branch -D`, `git worktree remove --force` or `git push --delete` to make a refusal go away).

| Rule | Meaning |
|---|---|
| `pr-ambiguous` | gh lists several pull requests for the branch, or one in an unknown state |
| `pr-closed` | the pull request was closed without merging |
| `pr-other-base` | the pull request was merged into a branch other than base |
| `main-worktree` | the branch is checked out in the main worktree |
| `running-from` | the branch's worktree holds the directory deuce runs from |
| `locked` | the worktree is locked (`git worktree lock`) |
| `missing-worktree` | the worktree directory is gone; `--apply` prunes the metadata, and the next sweep cleans the branch |
| `dirty` | the worktree has uncommitted or untracked changes |
| `pr-unpushed` | the branch has commits that are not in the merged pull request |
| `remote-ahead` | the remote branch has commits that are neither on the branch nor merged |
| `safe-delete` | `git branch -d` would refuse, even after fast-forwarding the base (often a base worktree with uncommitted changes) |

Kept, not refused: the base branch, protected names (`main`, `master`, `develop`, `release/*`, plus `protect` in `.deuce.toml` and `DEUCE_PROTECT`), branches with no commits yet, unmerged branches, and branches whose PR is open. Detached-HEAD worktrees are skipped with a note.

## Undo

Every applied action goes to an audit log. `deuce undo --last` recreates the last deleted local branch at its logged tip, and prints the commands to re-push the remote branch and re-add the worktree. Offer it if something was deleted by mistake; do not run it unasked.
