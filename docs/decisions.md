# Decisions

Each entry is taken from the commit history, merged PRs, the CHANGELOG or
existing docs. Where the record shows the decision but not the options weighed
against it, the entry says "alternative not recorded".

## 1. A guard hook on top of deny rules and the OS sandbox

**Context.** Claude Code's `Bash(...)` deny rules match the command text, not
the program, so `/bin/rm -rf`, `sh -c '...'` and `git -C dir push -f` pass
them.

**Decision.** Ship `hooks/sous-guard.sh` as a `PreToolUse` hook on every Bash
call, alongside the deny rules `sous install` writes and the OS sandbox. The
hook fails closed: `timeout: 30` and `onFailure: "block"` in
`hooks/hooks.json`, and commands over 64KB are blocked rather than scanned.

**Alternatives considered and why rejected.**
- Deny rules alone: they miss the spellings above.
- The sandbox alone: the README names it as the boundary but says none of
  the three (deny rules, guard, sandbox) is enough alone. Why the sandbox
  alone falls short is not spelled out further.
- Claude Code's default on hook timeout, which lets the command through:
  rejected in PR #33 after an audit found a guard process that ran for 40
  minutes on a very large input.

**Consequences.** The guard is a text matcher, so a path built at runtime or
reached after `cd` is a known gap, listed in `SECURITY.md` and asserted by
`check 0` rows under `KNOWN_GAP`. It runs on every Bash call, so `sous doctor`
fails when it takes over 500ms (`SOUS_GUARD_MS`). Every rule needs a block and
an allow fixture before it ships.

**Evidence.** README section "Why a hook when there are deny rules";
first commit 4a06c00; [PR #33](https://github.com/OrenSegal/sous/pull/33)
(3966d24); `tests/rules.test.sh`, `tests/adversarial.test.sh`.

## 2. `tests-ran` reports the largest count, not the sum

**Context.** A test run can exit green having executed nothing: `xcodebuild`
with a filter that matches no test, pytest, Vitest, Jest and `go test` with an
empty selection.

**Decision.** `bin/tests-ran` reads a log and reports the largest test count
on any line, and a log with no count line at all reports 0. It is a
zero-detector, not a coverage number.

**Alternatives considered and why rejected.**
- Summing the counts: XCTest repeats its total once per nested suite, so a
  sum counts the same tests several times.
- Treating a log with no count line as "unknown": Swift Testing prints nothing
  when a selector matches no test, so silence is the signal.

**Consequences.** Parallel shards and mixed harnesses are undercounted, so a
`--min` floor has to allow for that.

**Evidence.** Comment in the `awk` block of `bin/tests-ran`; commit 0ac94de;
`tests/tests-ran.test.sh`.

## 3. `tests-weakened` reads the diff, as a heuristic

**Context.** A change can go green by deleting, skipping or loosening the test
that failed. `tests-ran` cannot see that, because the tests still run.

**Decision.** `bin/tests-weakened` reads a diff (stdin, or the merge base with
a ref) and flags edits in test files: deleted, skipped, fewer assertions,
loosened (`== 42` to `is not None`), commented out, an early `return`, a dummy
body, a test moved out of its directory, an ignore added to test config. A
finding is a question for the author, not a verdict. Diffing from the merge
base means tests the base gained later do not read as deleted.

**Alternatives considered and why rejected.** Alternative not recorded. The
script's header says it reads the diff, not the code, and accepts being a
heuristic as the cost.

**Consequences.** It misses a weakened helper, a block comment and
`if False:` (listed in PR #33 and the README). `sous gate` fails a branch on
any finding.

**Evidence.** Header of `bin/tests-weakened`; CHANGELOG 0.3.1 and 0.4.0;
[PR #33](https://github.com/OrenSegal/sous/pull/33); `tests/tests-weakened.test.sh`.

## 4. Plugins live in this repo; blast-shield moved out, then back in

**Context.** cited, scoped, deuce, architecture-lint and blast-shield started
as separate repos pinned by tag in the sous marketplace.

**Decision.** In 0.4.0, cited, scoped, deuce and architecture-lint moved into
`plugins/<name>` with `git subtree add` (no `--squash`, so the original commit
SHAs are kept), and the marketplace lists them as `./plugins/<name>`.
blast-shield went the other way, out of `mods/blast-shield` to its own
Apache-2.0 repo, pinned at a tag. PR #39 reversed that: blast-shield 1.2.2 now
lives at `plugins/blast-shield`, with its `LICENSE` and `NOTICE` in its folder.

**Alternatives considered and why rejected.**
- Keep blast-shield in its own repo and bump the pin to v1.2.2 (PR #37, closed
  unmerged). Rejected in PR #39: the 2026-11-05 portfolio audit found the
  separate repos read as unrelated hobby projects when they are one system,
  and the tag pin had left marketplace users on v1.2.0 without the fail-closed
  hook fix.
- The licence, the original reason to move it out, was judged not to require a
  separate repo: an Apache-2.0 subdirectory inside an MIT repo is normal when
  its LICENSE and NOTICE travel with it.

**Consequences.** One CI workflow runs every plugin's own suite from its
folder. `git log -- plugins/<name>` shows only the import merge; a plugin's
own history is reached through the merge's second parent. sous is MIT except
`plugins/blast-shield`.

**Evidence.** [PR #22](https://github.com/OrenSegal/sous/pull/22) (a60721d),
[PR #30](https://github.com/OrenSegal/sous/pull/30) (8c7c7d5),
[PR #37](https://github.com/OrenSegal/sous/pull/37) (closed),
[PR #39](https://github.com/OrenSegal/sous/pull/39) (8583721); CHANGELOG
0.4.0 and Unreleased; the README toolkit table, which `tests/install.test.sh`
checks against `marketplace.json`.

## 5. cited's hosted app stays out of the plugin

**Context.** When cited moved into `plugins/cited`, its repo also held a
Vercel web app (`hosted/`, `api/index.py`, `vercel.json`) with a Stripe
webhook tested only against a fixture.

**Decision.** The plugin copy drops the hosted app and its tests. OrenSegal/cited
keeps it.

**Alternatives considered and why rejected.** Shipping the plugin with the app
(what `main` briefly did after PR #22 merged early). Rejected in PR #30 so
plugin installs do not receive a web app and an unverified Stripe webhook.

**Consequences.** `plugins/cited` and OrenSegal/cited differ: the plugin has
215 tests where the full repo had 280 (65 hosted tests removed). The cited
README in the plugin says the hosted app is not part of it.

**Evidence.** [PR #30](https://github.com/OrenSegal/sous/pull/30) (8c7c7d5);
CHANGELOG 0.4.0.
