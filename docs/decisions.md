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
`plugins/<name>` with `git subtree add`, and the marketplace lists them as
`./plugins/<name>`. The subtree adds kept full history on the PR branch, but
PR #22 was squash-merged, so `main` holds one commit (a60721d) and none of
their earlier SHAs.
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
folder. For cited, scoped, deuce and architecture-lint, history before 0.4.0
lives only in the standalone repos. blast-shield's import (#39) was a merge
commit, so its history is reachable through e9b21e0's second parent (7aa4dd1).
sous is MIT except `plugins/blast-shield`.

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

**Consequences.** `plugins/cited` and OrenSegal/cited differ: at PR #30 the
plugin had 215 tests where the full repo had 280 (65 hosted tests removed).
After the 2026-11-07 resync (entry 6) the plugin runs 228. The cited
README in the plugin says the hosted app is not part of it.

**Evidence.** [PR #30](https://github.com/OrenSegal/sous/pull/30) (8c7c7d5);
CHANGELOG 0.4.0.

## 6. Keeping the plugin copies in step with their old repos

**Context.** After 0.4.0 each plugin existed twice: `plugins/<name>` here and
its standalone repo. Nothing tied them together. There is no `git subtree
pull`, no sync script and no test that compares the two; fixes were applied by
hand to each copy. On 2026-11-02 cited's near-number fix landed in
OrenSegal/cited at 07:54 (5b6346e, released there as 0.5.0) and in sous at
09:32 (fc23966, labelled 0.4.1), the same code under two versions. A
2026-11-07 comparison of each standalone `origin/main` against its copy found
commits only the standalone had: blast-shield 42d94d2, scoped ba5ee59 and
4faac64, deuce 6d40c66, architecture-lint 015fccf, and cited's benchmark,
sample certificate and two README limitations.

**Decision.** Which copy leads depends on the repo:
- blast-shield, scoped, deuce and architecture-lint: `plugins/<name>` is
  canonical. scoped's and deuce's READMEs already say so in a "Moved" banner;
  blast-shield and architecture-lint get the same banner (their PRs, opened
  2026-11-07). The standalone repos take no more changes and can be archived.
- cited: OrenSegal/cited is canonical, because it also holds the hosted app
  (entry 5) and work still lands there first. `plugins/cited` is a downstream
  copy without `hosted/`, `api/` and `vercel.json`.

Resync procedure for cited, run by hand after a change merges in
OrenSegal/cited:

```bash
git -C ../cited fetch origin
mkdir /tmp/cited-tree && git -C ../cited archive origin/main | tar -x -C /tmp/cited-tree
rsync -a --exclude hosted/ --exclude api/ --exclude vercel.json \
  --exclude tests/test_hosted.py --exclude tests/test_recheck.py \
  --exclude .gitignore --exclude .claude-plugin/plugin.json \
  --exclude CONTRIBUTING.md --exclude CODE_OF_CONDUCT.md --exclude ruff.toml \
  --exclude tests/conftest.py --exclude skills/cited/scripts/certificate.py \
  /tmp/cited-tree/ plugins/cited/
git diff plugins/cited   # restore the sous badge, install lines and hosted note
```

then bump `version` in `plugins/cited/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` to match `safe_fetch.VERSION`, and run
`(cd plugins/cited && python3 -m pytest tests)`. The excluded files are
ported by hand: `certificate.py` differs only in comments that name the hosted
pages, so copy code changes into it (the inline favicon `ICON` was ported
this way); the README needs the sous badge, install lines and the
"sous copy" note restored, and the hosted node removed from its diagram.

**Alternatives considered and why rejected.**
- `git subtree pull`: needs the subtree's history on `main`, which the squash
  merge of PR #22 removed, and would bring `hosted/` back each time.
- A test in `tests/ssot.test.sh` that compares the copies: it would need the
  other repo or the network, and sous's tests touch neither (CONTRIBUTING).
- Making the sous copy canonical for cited: not chosen because the hosted
  app has to live somewhere and splitting the engine from it would mean a
  second resync in the other direction. Not recorded as an explicit decision
  before this entry.

**Consequences.** The cited copy drifts until someone resyncs it, and nothing
fails when it does. The version string is not a reliable check: both copies
read 0.5.0 while the bench intervals and the favicon had drifted. Diff the
trees instead (`diff -r` against a `git archive` of cited main, with the
exclusions above). Archiving the four
standalone repos removes the drift for them.

**Evidence.** 5b6346e (OrenSegal/cited) and fc23966 (sous); the ports and the
cited resync to a6718f6 in [PR #42](https://github.com/OrenSegal/sous/pull/42);
the "Moved" banners in OrenSegal/scoped (#16) and OrenSegal/deuce (#9).
