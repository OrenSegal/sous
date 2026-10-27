# Contributing

## Setup

```bash
git clone https://github.com/OrenSegal/deuce.git
cd deuce
python3 -m pip install -r requirements-dev.txt   # pytest and ruff, for development only
```

deuce itself is Python 3.10+ and standard library only, and needs git. Keep it that way: no runtime dependencies. `gh` is optional at runtime and never needed by the tests.

## Checks

The same commands CI runs:

```bash
ruff check .
shellcheck bin/deuce evals/*/setup.sh
python3 -m pytest tests -v
```

And, with Claude Code installed:

```bash
claude plugin validate .claude-plugin/plugin.json --strict
claude plugin validate .claude-plugin/marketplace.json --strict
claude plugin validate commands --strict
claude plugin validate skills --strict
```

The test suite makes no network calls and never touches your repositories, your git config or `~/.local/state`.

## Layout

| Path | What it is |
|---|---|
| `deuce/__init__.py` | `__version__`, the one place the version lives. |
| `deuce/gitrepo.py` | Everything deuce asks git: branches, worktrees (`git worktree list --porcelain`), ancestry, `git cherry`, status. Reads only. |
| `deuce/evidence.py` | Is a branch merged, and how do we know: `gh pr list`, then ancestry, then `git cherry`. |
| `deuce/plan.py` | `RULES`, and the decision for each branch, with the exact commands a sweep would run. Changes nothing. |
| `deuce/execute.py` | Runs a plan under `--apply` and writes the audit log. The only module that changes the repository. |
| `deuce/audit.py`, `deuce/lock.py` | The audit log (TSV) and the per-repository lock. |
| `deuce/report.py` | The JSON report and the text output. |
| `deuce/config.py` | Protected names: defaults, `.deuce.toml`, `DEUCE_PROTECT`. A small TOML reader for Python 3.10. |
| `deuce/cli.py` | Arguments, exit codes, `undo`. |
| `bin/deuce` | POSIX sh launcher that finds Python 3.10+ and runs the package isolated (`-I`). On PATH when the plugin is enabled. |
| `commands/`, `skills/deuce/SKILL.md` | `/deuce:sweep`, `/deuce:status` and the skill. |
| `evals/` | `claude plugin eval` cases. Not run in CI. |

## Tests

| File | Covers |
|---|---|
| `test_sweep.py` | `deuce sweep` end to end against real git: merge, squash and rebase merges, gh evidence, and one test per refusal, each checking that nothing was touched. The lock and the audit log. |
| `test_status_undo.py` | `deuce status` and `deuce undo --last`. |
| `test_cli.py` | Usage errors, `.deuce.toml`, and `bin/deuce` (isolation, symlinks, `DEUCE_PYTHON`). |
| `test_docs.py` | The README, SKILL.md, the commands and the manifests match the code: exit codes, flags and defaults, rules, the JSON shape, audit log columns, the version, and that no command pre-approves `--apply`. |

`conftest.py` gives every test a temp `HOME`, an empty global git config, a temp `DEUCE_STATE_DIR`, and a `PATH` built from symlinks to git and the few tools the launcher needs, so a real `gh` on the machine is never found. The `sandbox` fixture builds a bare repository as the remote, a clone with `main`, and helpers for branches, worktrees and the three kinds of merge (done in a second clone, as GitHub would). The `fake_gh` fixture puts `tests/fakes/gh` on PATH; it answers `gh pr list` from canned data and logs its calls.

## Making changes

- **Fixes come with a test that fails without them**, built as a real repository with the sandbox, not with mocks of git.
- **A new way to lose work is a new rule.** Add it to `plan.RULES`, refuse in `plan.decide`, add a test that checks the branch, its worktree and its remote branch are untouched, and add a row to the README's Rules table and SKILL.md (`test_docs.py` checks both).
- **Only `execute.py` changes the repository.** Planning and `status` must stay read-only; the dry run tests check it.
- **No force flags.** Do not add `--force` to `git worktree remove`, or a way to skip a refusal. The one force delete has one condition; widening it needs a SECURITY.md update in the same pull request.
- **The output is an interface.** Exit codes, the JSON report and the audit log columns are documented in the README, and `test_docs.py` fails if they drift. Adding a field is fine; renaming or removing one, or changing an exit code, needs a `schema_version` bump and a CHANGELOG entry.

## Evals

```bash
claude plugin eval . --scaffold --allow-tools Bash Skill
```

They call a model and cost money. Run them when you change `SKILL.md`, a command, or anything that changes what the agent sees. Each case's `setup.sh` builds a throwaway repository in the eval workspace. Results land in `evals/results/`, which is ignored by git.

## Releases

Bump `__version__` in `deuce/__init__.py`, the version in `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` (a test checks they match), and move the `Unreleased` CHANGELOG entries under the new version. Push a `v<version>` tag; the release workflow checks the tag against `deuce.__version__` and publishes the CHANGELOG section as the release notes.

## Pull requests

Open against `main` and fill in the template. Describe the problem, not just the change. Be decent; see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
