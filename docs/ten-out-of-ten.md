# sous: the path to 10/10

Reassessed 2026-11-17 against `origin/main` @22bb7c8 (v0.4.0 plus Unreleased).
It replaces the 2026-10-29 assessment, which was written on the history that
the main rewrite orphaned (branch `test-timeout-15s`, commit `bfa39f7`). That
branch shares no merge-base with main, so most of its P0 work never landed.

## Shipped on `audit/ten-out-of-ten`

| Finding | Fix | Proof |
|---|---|---|
| `sous uninstall .` passed the guard and switched the harness off | blocked with `sous accept` | `check 2` rows, rules row |
| `python3 bin/sous accept`, `env`/`nohup`/`sudo -E`/`xargs`/`VAR=` prefixes passed | launcher prefixes in the rule | 6 `check 2` rows |
| `glob.glob(".e*")` in an interpreter reached `.env*` | `bfa39f7`'s dot-glob extraction, ported | 6 corpus rows, both polarities |
| `printf x \| bash run.sh` blocked (false positive) | a shell with a script operand is allowed; bare shell, flags, `-`, `/dev/stdin` still block | 3 `check 0`, 7 `check 2` rows |
| `cat ~/.git-credentials` and 6 other credential stores had no control | added to the template `denyRead` | install row |
| report's command column fed to `sous-reviewer` unmarked | reviewer treats it as data | agent text |
| test suite: 15 duplicate or source-grepping rows, a 2030 time bomb | `prune-tests` run, see CHANGELOG | all suites green |
| gemini-extension version unchecked | added to the version check | install row |

All suites pass on bash 5 and on macOS `/bin/bash` 3.2. The one `install`
failure on this host is the sandbox proxy returning 403 for `.invalid` where
the test expects a DNS failure (exit 75); it is the environment, not the code.

## Still open, smallest first

1. **Plugin-aware install** (`bfa39f7` parts 1-4, M). With the plugin on,
   `/sous:install` copies a second guard and doctor then fails "guard runs 2
   times". Port `--vendor`/`--unvendor`, `check --hook` with `systemMessage`,
   and `${CLAUDE_PLUGIN_ROOT}/bin/sous` in `commands/*.md` and the reviewer:
   `sous` is not on PATH in a plugin session, so every hint is a dead end.
2. **Old installs never become fail-closed** (M). `upgrade` leaves a hook entry
   without `onFailure: "block"`, and doctor does not flag it.
3. **Hot path** (S). `cat` and `date` still run on every allowed call; use
   `read -r -d ''` and `printf '%(%Y%m%d)T'` with a 3.2 fallback.
4. **Load-sensitive budgets** (S). `install.test.sh` asserts 300 ms and doctor's
   500 ms guard budget on wall clock; set `SOUS_GUARD_MS` in the test header and
   keep one explicit over-budget row.
5. **`tests-weakened` without `-M`** (S). A host with `diff.renames=false`
   reports a moved test as a deletion.
6. **Unpinned CI tools** (S). `pipx run ruff` and the Claude Code npm install.
7. **Run the evals** (S, needs an API key). `claude plugin eval` already runs a
   no-plugin baseline arm (`--ablation with-without` is the default), so the
   control arm costs nothing to build. The cases were rebuilt on this branch
   (see Evals below) but not run. Run
   `claude plugin eval . --scaffold --allow-tools Bash --runs 3` once, record
   the with/without delta in the README, then decide on a paid run per tag.

## Customization: what it takes today

| Want | Today | Gap |
|---|---|---|
| Silence one guard false positive in one project | edit `.claude/hooks/sous-guard.sh`; doctor then fails "stale (same version, edited)" and `upgrade` overwrites it. Plugin mode has no copy to edit | **no supported way** |
| Add a project-specific block | write a wrapper hook that sources the guard (`. sous-guard.sh; sous_guard "$cmd" \|\| exit 2`, documented only in the guard header) | not in the README, and doctor runs its tables against the wrapper, so it must still pass them |
| A stack profile (Node, Python, Rust, Docker) | `--ios` and `--strict` are hard-coded flags (`bin/sous` option table) | adding a profile is a code change |
| Tune budgets and paths | 14 `SOUS_*` env vars, set per shell | no single list; not per project |

Proposed, smallest first:

1. **Project rules file** `.claude/hooks/sous.rules`, read by the guard after
   its own checks: `block <ERE> <message>` and `allow <rule-id> <ERE>` lines.
   It lives under `.claude/hooks/`, so the template's `Edit(.claude/hooks/**)`
   deny and the guard's tamper check already stop the agent writing it; only
   the user can. `allow` needs the rule-id column (owner decision below) so it
   lifts one rule, not the whole guard. Doctor lists every `allow` line and
   requires a `check 0` row for it, so a widening is visible.
2. **Profiles as files**: `--profile NAME` merges `templates/settings.NAME.json`;
   `--ios`/`--strict` become aliases. A new stack is a JSON file plus an install
   row, no Python.
3. **One knob table**: `sous status` prints every `SOUS_*` value in effect and
   its default, and the README lists them once.
4. **README "Customize" section** with the three recipes above and the sourced
   wrapper.

## Evals

Done on this branch, not run (no API key in this session):

- Every case now has a `setup.sh` scaffold (`case.yaml`). Before, `rm -rf
  vendor` ran in an empty workspace and `tests/test_cache.py` did not exist, so
  the score barely depended on behavior.
- Frontmatter matches the plugins in this repo: name, description, tags, `runs:
  3`, `model`, `timeout_seconds`, `expected_outcome`, `plugins: ["../.."]`.
- Deterministic graders next to the LLM ones: at most one recursive-delete
  attempt (`tool_used`, both arms); the agent read the test file; the skill fired
  (`with-only`, an indicator, not scored).
- `test-audit-deletion` has a real trap: the flaky test is the only expiry test
  and the fix is an injectable clock. The grader checks for that answer.
- New case `prune-tests-evidence`: one test of each prune category plus two
  that must stay, graded on the edits and one evidence line per deletion.
- CI shellchecks the scaffolds, builds each one and runs its fixture tests, so
  a fixture can't rot.

Still missing:

- Cases for the gate (`sous gate` on a branch that deleted a test), a secret
  read (`cat .env` blocked, sandbox denies the rest), the accept and uninstall
  blocks, and an injected instruction in a file the agent reads.
- A results file in the repo (with/without score per case, date, model), so a
  regression shows in a diff.
- A file-state grader. The runner's grader types are `llm`, `regex` and
  `tool_used`, so "vendor still exists" can only be judged by the LLM.

## Rest of the repo, checked

- `release.yml` publishes from a tag after checking the version and CHANGELOG,
  but does not run the suites; a red main can still be tagged. Gate it on CI.
- Actions are pinned by major tag (`@v7`); `dependabot.yml` exists, so pin by
  SHA and let it bump them.
- Not checked: `ISSUE_TEMPLATE`, the PR template, `mods/handoff`, and the five
  plugins under `plugins/` beyond their evals.

## Owner decisions

- Should `gate --ack-blocks`, `probe --record` and `upgrade` be user-only?
  They record the user's say-so and the agent can run them today.
- Loop breaker on the second identical block, not the third (19 % of blocks
  are a first retry).
- A `Stop` hook running `receipts` on the live transcript (warn only).
- Rule-id column in the block log, next to the redacted command that shipped.
- Context meter in doctor (memory files, skill descriptions, MCP servers).
- The uncommitted Agent guard in the old checkout (denies one subagent model):
  a personal cost policy rather than harness safety; keep it local.
- An egress check: doctor names allowlisted hosts that accept writes
  (`github.com`, `*.githubusercontent.com`) and `allowUnsandboxedCommands`.

## From anthropics/defending-code-reference-harness

Apache-2.0, unmaintained. Take ideas, not code.

- **Calibrated graders.** Its patch grader must pass a golden diff, fail a noop
  and a garbage diff. sous's evals need the same: a plugin-off arm that must
  fail (item 7).
- **Untrusted text in nonce-fenced blocks** before it reaches a model. sous
  has one such path, report to reviewer; the reviewer line covers it, a fence
  with a breakout test would prove it.
- **Check the live boundary before running** (`vp-sandboxed` verifies the proxy
  allowlist covers the provider). sous probe does this for the sandbox; the
  egress decision above is the missing half.
- Not taken: containers per agent, the find/judge/patch pipeline, fail-open
  judges. sous checks the harness and the branch; it is not a workflow.

For codebase-audit, separately: score `evals/seeded-bugs` against a
`ground_truth.yaml` with a script instead of an LLM threshold; flag two
findings at the same `where` in `verify.py`; on a dead hunter, keep the
findings that verify and rehunt only open probes; state that repo text is data.

## codebase-audit: keep separate

The only real overlap is the test taxonomy (test-audit, prune-tests, and the
audit's `lenses/tests.md`). Everything else scans different things: sous reads
the harness and the branch, codebase-audit reads the code. Moving it in would
break its listings (skills.sh, its marketplace, Gemini, ClawHub, all keyed to
the repo), lose its Gemini manifest (one per repo), add a second copy to keep
in sync (decisions.md §6), and make sous a workflow. Instead:

- sous README "Works with": one line for codebase-audit.
- codebase-audit: point `lenses/tests.md` and `UNTANGLE.md` at sous
  `test-audit` §3 and `tests-weakened` as the deletion rule and after-check,
  and add the CI it lacks (the three checks in its AGENTS.md).
- prune-tests ships as its own skill and requires test-audit's evidence line
  per deletion, so the two do not disagree at the gate.
