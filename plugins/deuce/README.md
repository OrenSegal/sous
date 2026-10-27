# deuce

[![CI](https://github.com/OrenSegal/deuce/actions/workflows/ci.yml/badge.svg)](https://github.com/OrenSegal/deuce/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)

Part of [sous](https://github.com/OrenSegal/sous): tools for checking what coding agents actually do.

deuce is the cleanup after a pull request merges, squash merges included, and it refuses when cleaning up could lose work. For every local branch that is merged into the base branch, it removes the branch's worktree (only if clean), deletes the local branch and deletes the remote branch. Then it fetches with `--prune`, fast-forwards the base branch and prunes stale worktree metadata.

By default it does none of that: `deuce sweep` is a dry run that prints exactly what it would do and why. `--apply` does it.

It ships as a Claude Code plugin (a skill, `/deuce:sweep` and `/deuce:status`, and a `deuce` command-line tool), and the same tool runs anywhere with Python 3.10+ and git. Standard library only.

## Why

If you run many agents, each in its own worktree on its own branch, merged work leaves debris: worktrees, local branches, remote branches. deuce is worth using for one case: a branch whose pull request was **squash merged**, cleaned up **without losing work**. For everything else, the built-ins already do the job.

What the built-ins already do, and where they stop:

- **`git branch --merged main` with `git branch -d`** is already safe. git refuses to remove a dirty or locked worktree without `--force`, and `-d` refuses a branch that is not merged. It misses squash merges, because the branch's commits are not in the base branch. Adding `git push origin --delete` deletes a remote branch even when a teammate has pushed to it.
- **`git fetch --prune` and then deleting the `[gone]` branches** (the `clean_gone` command of the `commit-commands` plugin in the official Claude Code marketplace) does catch squash merges. But it runs `git worktree remove --force` and `git branch -D`, so it also deletes uncommitted files, commits that were never pushed, and branches whose PR was closed without merging.
- **Claude Code's own worktree cleanup** only touches worktrees that Claude Code created. It never deletes your branches or remote branches, and it decides "merged" from git state alone, so it cannot see a squash merge either.

The table shows one throwaway repository with a bare remote (git 2.54, with a fake `gh` standing in for GitHub). Each column is one cleanup run:

| Branch | `--merged` + `-d` | `[gone]` + `-D` | deuce with `gh` |
|---|---|---|---|
| regular merge | deleted | deleted | deleted (local main was behind, so it was fast-forwarded first) |
| squash merge | missed | deleted | deleted |
| squash merge, then a new local commit | kept | deleted; the new commit is left unreachable | refused `pr-unpushed` |
| merged, dirty worktree | git refused | worktree and its uncommitted files deleted | refused `dirty` |
| merged, locked worktree | git refused | `--force` stopped by the lock | refused `locked` |
| merged, a teammate pushed to the remote branch | local deleted; with `push --delete`, the teammate's commit is gone | kept | refused `remote-ahead` |
| PR closed without merging | kept | deleted | refused `pr-closed` |
| PR open | kept | kept | kept `pr-open` |

- **Squash merges need `gh`.** deuce asks GitHub for the branch's pull request, which is the only way to see a squash merge. Without `gh`, the run above found no merge that `git branch --merged` missed: the squash-merged branch was kept as `not-merged`.
- **It refuses instead of losing work.** It stops on dirty or locked worktrees, commits that are not in the merged PR, a remote branch someone pushed to, and a closed PR. In each case the branch is left exactly as it was.
- **It is recoverable.** Every applied action is logged with the branch's tip sha. In the run above, `deuce undo --last` recreated the deleted squash-merged branch at that sha.
- **A stale base is fast-forwarded first.** deuce does not fetch before planning. If your local base is behind and checked out where deuce runs, a branch that `git branch -d` would only accept after the base catches up gets a fast-forward of the base as its first step, so one sweep cleans it. If the base cannot be fast-forwarded (uncommitted changes, or local commits), the branch is refused as `safe-delete`.

## Install

As a Claude Code plugin:

```text
/plugin marketplace add OrenSegal/deuce
/plugin install deuce@deuce
```

This adds the `deuce` skill, the `/deuce:sweep` and `/deuce:status` commands, and puts `deuce` on the Bash tool's PATH while the plugin is enabled.

Without Claude Code, clone the repo and run `bin/deuce` (or `python3 -m deuce` from the repo). There is nothing to install. `gh` is optional.

## Use

In Claude Code, ask in plain words ("clean up the merged branches", "prune the old agent worktrees") and the skill takes over, or run `/deuce:sweep`. Either way the agent runs the dry run, shows it to you, and runs `--apply` only after you approve. The commands pre-approve only the dry run and `status`; `--apply` always asks for permission.

From a shell:

```bash
deuce status                 # every branch: stale, kept or held, read-only
deuce sweep                  # dry run: what would be removed, and why
deuce sweep --apply          # do it
deuce sweep --base develop --remote upstream --json
deuce undo --last            # recreate the last deleted branch
```

A dry run looks like this:

```text
deuce sweep (dry run, nothing changed)
repo /work/app, base main (compared with origin/main)

keep    main: the base branch
sweep   agent/fix-login: PR #41 squash or rebase merged into main (gh)
    [planned] git worktree remove /work/app/.worktrees/fix-login
    [planned] git branch -D agent/fix-login  (force delete: PR #41 was squash merged and its head is this tip)
    [planned] git push --porcelain --force-with-lease=agent/fix-login:3f1c9e2a7b... origin --delete agent/fix-login
REFUSE  agent/search: uncommitted or untracked changes in /work/app/.worktrees/search (2, first: ?? notes.md)
keep    agent/wip: PR #44 is open

then:
    [planned] git fetch --prune origin
    [planned] git merge --ff-only --quiet 9d2e...
    [planned] git worktree prune
```

## Rules

Every local branch gets exactly one rule. `sweep` branches are cleaned by `--apply`; `keep` branches are not candidates; `refuse` branches look merged but a safety check failed, so they are left alone and the exit code is 1.

| Rule | Decision | When |
|---|---|---|
| `merged` | sweep | Merged into base by PR, ancestry or `git cherry`, and every check below passed. |
| `base` | keep | The base branch itself. |
| `protected` | keep | Matches a protected name or pattern (below). |
| `no-commits` | keep | Created and never moved, and not on the remote: a fresh agent branch. |
| `not-merged` | keep | No evidence that it is merged. Without `gh`, this includes multi-commit squash merges. |
| `pr-open` | keep | Its pull request is still open. |
| `pr-ambiguous` | refuse | gh lists more than one pull request for the branch name, or one in an unknown state. |
| `pr-closed` | refuse | Its pull request was closed without merging. |
| `pr-other-base` | refuse | Its pull request was merged into another branch (a stacked PR). |
| `main-worktree` | refuse | Checked out in the main worktree. |
| `running-from` | refuse | Its worktree holds the directory deuce runs from (or `--repo`). |
| `locked` | refuse | Its worktree is locked (`git worktree lock`); the lock reason is shown. |
| `missing-worktree` | refuse | Its worktree directory is gone. `--apply` prunes the metadata, and the next sweep cleans the branch. |
| `dirty` | refuse | Its worktree has uncommitted or untracked changes. Ignored files do not block, but they are named in the plan, since they go with the worktree. |
| `pr-unpushed` | refuse | It has commits that are not in the merged pull request. |
| `remote-ahead` | refuse | The remote branch has commits that are neither on the local branch nor merged. |
| `safe-delete` | refuse | `git branch -d` would refuse it, even after fast-forwarding the base, and the force delete is not allowed. |

Rules are checked in this order: base, protected, no commits, merge evidence, the worktree, the PR's commits, the remote branch, the delete.

For a `sweep` branch, `--apply` runs, in order, stopping at the first failure:

1. Only when `git branch -d` would otherwise refuse: a fast-forward of the base branch (`git merge --ff-only`, where it is checked out), so that git, which checks a branch with no upstream against `HEAD`, sees the merge. Skipped if an earlier branch already did it.
2. `git worktree remove <path>`, without `--force`, so git itself refuses a dirty worktree too.
3. `git branch -d <branch>`. The force delete (`-D`) is used only when the evidence is a squash-merged PR whose head sha is exactly the branch tip. The tip is re-read just before the delete; if it moved, the step fails.
4. `git push --force-with-lease=<branch>:<sha> <remote> --delete <branch>`, only if a remote-tracking branch exists. The lease is the sha deuce saw, so a push that landed since the last fetch makes this step fail (`stale info`) instead of being thrown away. A remote branch that is already gone (GitHub's auto-delete) counts as done.

Then, whatever happened to the branches: `git fetch --prune <remote>`, a fast-forward of the base branch (only a fast-forward, and skipped if the worktree where base is checked out has uncommitted changes), and `git worktree prune`.

deuce only acts on worktrees in `git worktree list`. Other clones and directories that merely look like worktrees are never touched. Worktrees with a detached HEAD are skipped with a note.

## Protected branches

These are never swept, whatever the evidence: `main`, `master`, `develop`, `release/*`, and the base branch. Add more (configuration only ever adds; the defaults cannot be removed):

```toml
# .deuce.toml at the root of the repository
protect = ["hotfix/*", "staging"]
```

or `DEUCE_PROTECT="hotfix/*, staging"` (comma or space separated). Patterns are shell-style (`fnmatch`), and `*` matches `/` too. `.deuce.toml` has no other keys; an unknown key is a usage error.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok, or nothing to do |
| 1 | a branch was refused, an action failed, or another deuce holds the lock |
| 2 | usage error: bad arguments, not a git repository, no such base branch, or a bad `.deuce.toml` |

`deuce status` exits 0 even when a sweep would refuse a branch. `deuce undo --last` with nothing to undo exits 0.

## Options

| Command | Flag | Default | |
|---|---|---|---|
| `sweep` | `--apply` | off | Do it. Without this flag nothing changes. |
| `sweep` `status` `undo` | `--repo DIR` | | The repository, or any of its worktrees. Default: the current directory. |
| `sweep` `status` | `--base NAME` | `main` | The branch merges land on. Compared through `<remote>/<base>` when it exists, else the local branch. |
| `sweep` `status` | `--remote NAME` | `origin` | The remote. If it does not exist, only local steps run, with a note. |
| `sweep` `status` | `--json` | off | Print the JSON report (below) instead of text. |
| `undo` | `--last` | | Required. Recreate the most recent deleted branch that has not been undone. |

`deuce --help` lists the exit codes too.

## JSON report

`--json` prints one object, for `sweep` and `status` alike. Fields are only added in later versions; a breaking change bumps `schema_version`.

```json
{
  "schema_version": 1,
  "deuce_version": "x.y.z",
  "command": "sweep",
  "applied": false,
  "repo": "/work/app",
  "base": "main",
  "base_ref": "origin/main",
  "remote": "origin",
  "notes": ["worktree /work/app/.worktrees/scratch has a detached HEAD; skipped (deuce cleans up branches only)"],
  "branches": [
    {
      "branch": "agent/fix-login",
      "tip": "3f1c9e2a7b0d4c5e6f708192a3b4c5d6e7f80910",
      "worktree": "/work/app/.worktrees/fix-login",
      "decision": "sweep",
      "rule": "merged",
      "reason": "tip is an ancestor of origin/main; gh not found, so a squash merge cannot be seen",
      "evidence": {"kind": "ancestor", "source": "git", "pr": null, "squash": false,
                   "detail": "tip is an ancestor of origin/main; gh not found, so a squash merge cannot be seen"},
      "actions": [
        {"kind": "remove-worktree", "command": "git worktree remove /work/app/.worktrees/fix-login", "status": "planned", "detail": ""},
        {"kind": "delete-branch", "command": "git branch -d agent/fix-login", "status": "planned", "detail": ""}
      ]
    }
  ],
  "finish": [
    {"kind": "fetch-prune", "command": "git fetch --prune origin", "status": "planned", "detail": ""}
  ],
  "summary": {"sweep": 1, "keep": 1, "refuse": 0, "failed": 0, "exit_code": 0}
}
```

- `branches` has every local branch. `decision` is `sweep`, `keep` or `refuse`; `rule` is a row of the Rules table.
- `evidence.kind` is `pr`, `ancestor`, `cherry`, or `null` when no merge was found. `evidence.source` is `gh` or `git`, and `detail` says why gh was not used when it was not.
- Action and finish `kind`s: `remove-worktree`, `delete-branch`, `delete-remote-branch`, `fetch-prune`, `fast-forward`, `prune-worktrees`. `status` is `planned` (dry run), `done`, `failed` or `skipped`.
- `remote` is `null` when the remote does not exist.

## Audit log and undo

Every action `--apply` runs is appended, done or failed, to `~/.local/state/deuce/log.tsv` (or `$DEUCE_STATE_DIR/log.tsv`). Dry runs and `status` write nothing. The columns:

`time` `repo` `action` `status` `branch` `sha` `remote` `path` `detail`

`repo` is the repository's git common directory, so every worktree of one repository shares its history. `sha` is the tip of a deleted branch, or the lease of a deleted remote branch.

`deuce undo --last` recreates the most recent deleted branch of this repository that has not been undone yet, at the logged sha, and prints the commands to re-push the remote branch and re-add the worktree; it does neither itself. Run it again to walk further back. It never overwrites an existing branch (exit 1), and it fails if the commit has been garbage collected (a deleted branch's commits stay reachable from the reflog for a while, but not forever).

## Concurrency

`sweep --apply` and `undo` take an exclusive lock (`deuce.lock` in the git common directory), so two of them cannot race in the same repository; the second exits 1. The dry run and `status` only read and take no lock. Between a dry run and `--apply`, the plan is computed again from scratch, so `--apply` acts on the repository as it is then, not as it was when you read the dry run.

## Security

deuce deletes things, so its threat is losing work, not an attacker: a branch with commits that exist nowhere else, a worktree with uncommitted files, a remote branch a teammate pushed to. Every rule above leans toward refusing. It never uses `git worktree remove --force`, never deletes a remote branch without a lease, and uses the force delete in only one case. It runs `git` and `gh` as you; it sends nothing anywhere else. [SECURITY.md](SECURITY.md) lists what is and is not enforced.

## Limitations

- **POSIX only.** The lock uses `fcntl`; deuce does not run on Windows outside WSL.
- **Squash merges need `gh`.** Without it (or logged out), a multi-commit squash-merged branch is kept as `not-merged`. A one-commit squash and rebase merges are found by `git cherry`.
- **gh matches pull requests by branch name.** A pull request from a fork with the same branch name counts too; two PRs means `pr-ambiguous`, and a fork's PR with a different head means `pr-unpushed`. Both are refusals, not deletions.
- **Remote state is as of the last fetch.** deuce does not fetch before planning, so the dry run and `--apply` agree. The fetch at the end of `--apply` means the next sweep sees more. The lease on the remote delete catches a push that landed in between.
- **One remote.** Remote branches are matched by name on `--remote`; a branch whose upstream lives on another remote keeps its remote branch.
- **Ignored files go with their worktree.** `git worktree remove` deletes ignored files (`.env`, build output). The plan names them; read it.

## Evals

`evals/` holds a [`claude plugin eval`](https://code.claude.com/docs/en/plugin-evals) suite: one case where the user asks to clean up after a merge and the agent must show the dry run and not apply it without approval, and one where the user only asks what is stale. Each case builds a throwaway repository with a scaffold script. They call a model and cost money, so CI does not run them:

```bash
claude plugin eval . --scaffold --allow-tools Bash Skill
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
