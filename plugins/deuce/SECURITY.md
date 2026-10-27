# Security

## Reporting

Report a vulnerability through GitHub's private advisory form on this repo ("Security" tab, "Report a vulnerability"), not a public issue.

## Threat model

deuce deletes worktrees and branches, locally and on a remote, often at an agent's request. The thing to defend is work that exists in only one place:

- a worktree with uncommitted, untracked or staged changes;
- local commits that never reached the merged pull request;
- a remote branch that someone pushed to after the merge;
- a branch an agent created a moment ago and has not committed to yet;
- the branch, or the worktree, that a person or another agent is using right now.

The second risk is an agent deciding by itself to run the destructive step. The plugin keeps `--apply` behind the user.

## Enforced

| Area | What deuce does |
|---|---|
| Default | `deuce sweep` is a dry run. Nothing changes without `--apply`. `status` only reads. |
| Merge evidence | A branch is swept only with evidence: a single merged PR into base (gh), or the tip being an ancestor of `<remote>/<base>`, or `git cherry` finding every commit there. Several PRs, a closed PR, or a PR into another branch are refusals, even if git ancestry says merged. |
| Worktrees | Removed only with `git worktree remove` (never `--force`), only if listed by `git worktree list`, and only when `git status` shows no changes, staged or untracked. Locked worktrees, the main worktree and the worktree deuce runs from are refused. Ignored files that would go with a worktree are named in the plan. |
| Local branch | `git branch -d`. The force delete only when the evidence is a squash-merged PR and the branch tip is exactly the PR's head sha. Local commits not in the PR are a refusal. The tip is re-read just before deleting; if it moved, the step fails. |
| Remote branch | Deleted only if a remote-tracking ref exists, with `--force-with-lease=<branch>:<sha deuce saw>`, so a push since the last fetch is not thrown away. A remote branch with commits that are neither on the local branch nor merged is a refusal. |
| Base branch | Only fast-forwarded (`merge --ff-only`, or `update-ref` with the old value when it is not checked out), and skipped when its worktree has uncommitted changes. Never reset. |
| Names | `main`, `master`, `develop`, `release/*` and the base branch are never swept. Configuration can only add names. |
| Concurrency | `--apply` and `undo` hold an exclusive lock per repository. |
| Recovery | Each applied action is appended to an audit log with the branch name, tip sha, remote and worktree path. `deuce undo --last` recreates the branch and never overwrites one. |
| Plugin | `/deuce:sweep` and `/deuce:status` pre-approve only `deuce sweep`, `deuce sweep --json`, `deuce status` and `deuce status --json`, as exact commands. `--apply` is never pre-approved, so Claude Code asks before it runs. The command and the skill tell the agent to show the dry run and wait for approval, and not to work around a refusal. A test checks that no command's `allowed-tools` grants `--apply` or a wildcard. |

## Not enforced

- **Ignored files are deleted with their worktree.** `.env` files, build output and anything else in `.gitignore` do not block removal; the plan names them.
- **gh is trusted.** If `gh` answers that a PR merged with a given head, deuce believes it. A malicious `gh` on PATH could get a branch force-deleted (the commits stay recoverable through the audit log and the reflog until garbage collection).
- **Remote state is as of the last fetch.** The lease protects the remote delete, but the merge evidence is whatever the remote-tracking refs and gh say at plan time.
- **Undo is local.** `deuce undo --last` recreates the local branch only. It cannot bring back a remote branch, a removed worktree's ignored files, or a commit that has been garbage collected.
- **The audit log is plain text** in your state directory. Anyone who can write to it can make `undo` recreate a branch at a sha of their choice (never over an existing branch).
- **The lock is advisory.** It stops two deuce processes, not git commands run by hand or by another tool at the same time.
- **Agents can still run git.** The plugin keeps deuce's `--apply` behind the user. It does not stop an agent from running `git branch -D` itself; use [sous](https://github.com/OrenSegal/sous) or permission rules for that.

## Out of scope

Deciding whether a merged branch should have been merged.
