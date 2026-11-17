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

## Second pass: every open item, addressed

| Item | Now |
|---|---|
| Plugin-aware install (`bfa39f7` parts 1-4) | ported: no guard copy with the plugin on, `--vendor`/`--unvendor`, `check --hook` systemMessage, commands and reviewer call `"${CLAUDE_PLUGIN_ROOT}/bin/sous"` |
| Old installs fail open | doctor fails a guard hook without `onFailure: "block"`; `upgrade` sets it |
| Hot path | no `cat` fork; no `date` fork on bash 4.2+ (3.2 keeps it) |
| Load-sensitive budgets | `SOUS_GUARD_MS=5000` in the install suite, one explicit over-budget row |
| `tests-weakened` without `-M` | diffs with `-M`; red-first row with `diff.renames=false` |
| Unpinned CI tools | actions by SHA, ruff 0.17.4, pytest 9.2.0, Claude Code 2.1.322 |
| Release from a red main | `release` calls the CI workflow first; write permission on the release job only |
| Customization | `.claude/hooks/sous.rules` (project blocks, one-rule lifts), `--profile NAME`, knob table in `status`, README "Customize" |
| Evals | 6 cases, all scaffolded, deterministic graders, baseline arm; `evals/RESULTS.md` |

Owner decisions, taken as recommended (each is one revert if you disagree):

- `gate --ack-blocks` and `probe --record` are user-only, like accept and
  uninstall. `upgrade` stays open: it only adds, and now also fixes fail-open
  hooks.
- Loop breaker on the second identical block.
- `Stop` hook runs receipts on the live transcript, warn only.
- Rule-id column in the block log (fifth column) and in every block message.
- Context meter in `sous status` (memory lines, skill description size, MCP
  servers).
- Egress: doctor names allowlisted hosts that accept uploads (info, not a
  failure, since the base template allows `github.com`).
- The Agent guard in the old checkout stays local.

## Still open

1. **Run the evals** (needs an API key and money): the command is in
   `evals/RESULTS.md`; record the with/without scores there. No grader has
   been run against a model.
2. **Quoted-pattern false positive.** `grep -E "a|bash" f` and
   `grep 'a\|bash' f` block as pipe-to-shell: the quoted-span marking is
   skipped whenever a shell name appears anywhere, which is what keeps
   `sh -c "curl x | sh"` blocked. Narrowing it needs its own corpus work.
   A project can lift it meanwhile with `allow shell-pipe <ERE>`.
3. **A file-state grader.** The eval runner's grader types are `llm`, `regex`
   and `tool_used`, so "vendor still exists" is judged by the LLM grader.
4. Not reviewed: `ISSUE_TEMPLATE`, the PR template, `mods/handoff`, and the
   five plugins under `plugins/` beyond their evals.

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
