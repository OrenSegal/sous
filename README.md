# sous

sous: tools for checking what coding agents actually do.

## The toolkit

| Plugin | What it checks | Install |
|---|---|---|
| [sous](https://github.com/OrenSegal/sous) | Bash calls that delete, force-push or read secrets; green test runs that ran nothing; whether the harness still holds | `claude plugin install sous@sous` |
| [litmus](https://github.com/OrenSegal/litmus) | Skill and prompt evals that could never have failed | `claude plugin install litmus@sous` |
| [cited](https://github.com/OrenSegal/cited) | Cited sources that don't contain the words, numbers or names a claim attributes to them | `claude plugin install cited@sous` |
| [scoped](https://github.com/OrenSegal/scoped) | Concurrent Claude Code sessions editing the same files | `claude plugin install scoped@sous` |
| [deuce](https://github.com/OrenSegal/deuce) | Branches and worktrees left behind after a merge (dry run first, audit log, undo) | `claude plugin install deuce@sous` |
| [handoff](mods/handoff) | A mod that writes a resume note and patch (`.claude/handoff/`) after each turn that changes the tree, so the next session can pick up | `claude plugin install handoff@sous` |

Add the marketplace once with `claude plugin marketplace add OrenSegal/sous`.
The rest of this page is about sous itself: a Claude Code harness you install
in one command, and a doctor that proves it still holds.

## The harness

Agent = model + harness. The model is rented; the harness is yours. sous
packages the harness as five layers, each backed by a file Claude Code
already reads:

| Layer | What holds it | sous adds |
|---|---|---|
| 1 Memory | `CLAUDE.md` / `AGENTS.md` | presence and size check |
| 2 Tools | `.mcp.json`, plugins | servers listed, unpinned ones named, the set fingerprinted so a change shows |
| 3 Permissions + sandbox | `.claude/settings.json` `permissions` + `sandbox` | deny `.env` read/edit, recursive force delete, force push; OS sandbox on with a network allowlist |
| 4 Hooks | `PreToolUse` | `sous-guard.sh`: hard stops for the spellings deny rules miss (`/bin/rm -rf`, `sh -c`, `git -C . push -f`, `cat .env`) |
| 5 Human gates | `permissions.ask`, user settings | push / commit / PR / unsandboxed retry ask first; bypass mode disabled |

It also ships the [`test-audit`](skills/test-audit/SKILL.md) skill, which gates
new tests on the behavior they prove and makes deletions show evidence, and
[`tests-ran`](bin/tests-ran), which exits 1 when a test log shows zero executed
tests, and [`tests-weakened`](bin/tests-weakened), which reads a diff and flags
the edit that made the tests pass by deleting, skipping or loosening them. `xcodebuild` reports success when a filter matches nothing, and pytest,
Vitest and Jest stay green when every test is skipped; `tests-ran --help` lists
the formats it reads. It reports the largest count it finds, not a sum, so it
is a zero-detector, not a coverage number.

Real output from `bash docs/demo.sh`, which feeds each command to the guard:

```text
$ /bin/rm -rf build
BLOCKED (sous): recursive force delete. Name the files, list them first, or ask the user.
  exit 2

$ git -C . push -f origin main
BLOCKED (sous): force, mirror or delete push. Ask the user; they run it themselves with ! if they want it.
  exit 2

$ sh -c 'cat .env'
BLOCKED (sous): sh touches .env, a secrets file. Read .env.example for the key names.
  exit 2

$ git status && ls src
  exit 0
```

Runs on macOS and Linux (bash and Python 3); on Windows use WSL.

New to harnesses, or deciding what to install? Read the
[harness guide](docs/harness-guide.md): what is necessary, how to treat mods and
plugins, and the gaps still open.

## What sous claims

Three claims, each one checked by something you can run:

1. **Every guard rule has a block fixture and an allow fixture.**
   `tests/rules.test.sh` pairs each rule with a command it must stop and a
   near-miss it must let through, and fails if a block message in
   `hooks/sous-guard.sh` has no pair. A rule that can't be shown blocking and
   allowing doesn't ship. The wider red-team corpus lives in
   `tests/adversarial.test.sh`.
2. **Every written prohibition maps to a control, or lint names it.**
   `sous lint` reads the "never" and "do not" lines in `CLAUDE.md` and
   `AGENTS.md`, takes the command or path in backticks, and asks the real guard
   and your deny rules whether it is enforced. It lists the rest, and the
   prohibitions with nothing checkable in them. `sous lint --fix` adds the
   missing deny rules through the manifest, so `uninstall` reverses them;
   `--dry-run` shows them first. Fenced code blocks are skipped, and `sous
   doctor` reports the same counts. Research on agent instruction files finds
   few security rules in prose map to a real control; this is the check for that.
3. **The agent can't switch the harness off.** `install` deny-lists `Edit` on
   `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/**`
   and `.mcp.json`. Deny rules hold in every permission mode, and the existing
   bypass-mode check covers the mode that skips `ask`. `sous doctor` fails when
   one is missing. Known gap: an interpreter writing the file
   (`python -c "open('.claude/settings.json','w')..."`) is not a text match, so
   the OS sandbox's write scope is the boundary there.

A change to the tool set shows too: `sous probe --record` fingerprints the
`.mcp.json` servers (names and shape, never env or header values) and the
enabled plugins with their versions. `sous doctor` notes drift, and `--strict`
fails on it until you review the change and record again.

## Install

```bash
git clone https://github.com/OrenSegal/sous ~/.sous
~/.sous/bin/sous install /path/to/project --dry-run   # see what changes
~/.sous/bin/sous install /path/to/project
~/.sous/bin/sous doctor  /path/to/project
```

`install` is additive: lists gain missing entries, existing values are kept and
reported. It reads JSON with comments but won't rewrite it, writes atomically,
and records what it added in `.claude/sous.manifest.json`. It never edits
`~/.claude`; add this line there yourself, since bypass mode skips every `ask`
gate:

```json
{ "permissions": { "disableBypassPermissionsMode": "disable" } }
```

For unattended runs add `--strict`: a command the sandbox blocks then fails
instead of retrying outside it (`sandbox.allowUnsandboxedCommands: false`).

The plugin carries the guard hook, a `SessionStart` check that is silent when
layers 3 and 5 are present, `/sous:install`, `/sous:doctor`, `/sous:report`,
the `sous-reviewer` agent, `test-audit` and `tests-ran` (its `bin/` goes on
PATH). A plugin can't set permissions or the sandbox, so run `/sous:install`
once per project. If the project also has the copied guard, the guard runs
twice; `sous doctor` fails on that and says how to keep one.

### Upgrade and uninstall

```bash
git -C ~/.sous pull
~/.sous/bin/sous upgrade   /path/to/project   # refresh the guard copy, add new defaults
~/.sous/bin/sous uninstall /path/to/project --dry-run
~/.sous/bin/sous uninstall /path/to/project
```

`upgrade` removes nothing. `uninstall` reverses only what the manifest says
sous added: your own rules, values you changed since, and an edited guard copy
stay; values `--strict` overrode go back. Installs before 0.3.0 have no
manifest, so `uninstall` refuses there. Either remove by hand what
[`templates/`](templates) lists plus `.claude/hooks/sous-guard.sh` and
`.claude/skills/test-audit`, or run `sous upgrade` first; `uninstall` then
removes what that upgrade added.

## Doctor, report, probe

`sous doctor` checks every layer and also fails on bloat and rot: a memory
file over `SOUS_MEMORY_LINES`, duplicate rules, rules naming scripts that no
longer exist, a guard slower than `SOUS_GUARD_MS`, a stale or doubly wired
guard, plugin hooks pointing at missing files, CRLF line endings, and settings
that only parse as JSONC. It runs the guard tables against the hook Claude Code
will actually call. `--strict` also fails when the host can't start the sandbox
(macOS needs `sandbox-exec`; Linux and WSL2 need `bwrap` and `socat`) or when
the settings changed since the last recorded live probe.

Doctor reads `.claude/settings.local.json` over `settings.json`, assuming lists
add up and local scalars win. Claude Code's docs don't confirm that, so doctor
says so when a local file is present.

The guard appends each block to `~/.claude/sous/blocks.tsv` as a timestamp, a
reason and the project directory, never the command text (`SOUS_LOG=off`
disables it). `sous report`
counts blocks by reason: a false positive becomes a `check 0` row in
`tests/adversarial.test.sh`, a bypass a `check 2` row, and a rule that never
fires is a deletion candidate.

The sandbox is Claude Code's runtime, not a file, so only a live session can
prove it. `sous probe` prints prompts to paste into a fresh session; once they
all hold, `sous probe --record DIR` stores a fingerprint of the permissions and
sandbox settings, and doctor notices when they change.

## Gate and fleet

`sous gate [DIR] [--base REF]` exits 0 only when the branch is safe to merge.
Each check is named and prints a one-line fix: the tree is clean and pushed
(as of the last fetch), the tests ran after the last edit (`tests-ran` on
`<git dir>/sous-test.log`, or `--test-log` / `SOUS_TEST_LOG`), no test was
weakened since the merge base (`tests-weakened`), the guard blocked nothing in
this worktree since the branch forked, and doctor has no FAIL. Blocks you
reviewed stay acknowledged after `sous gate --ack-blocks`. A linked worktree
whose `.claude` settings or `.mcp.json` differ from the main checkout's gets a
warning: a gitignored `settings.local.json` is not checked out into a new
worktree. With [scoped](https://github.com/OrenSegal/scoped) on `PATH`, a
changed file another session claims fails the gate. `--json` prints the same
checks.

`--transcript=FILE.jsonl` also compares the session's final message with its
tool calls. "Tests pass" or "fixed" fails when the last test command exited
non-zero, or when the test command was stopped or sent to the background and
never finished; a claim with no test command in the transcript only warns (a
wrapper script may have run them). It reads Claude Code's transcript format,
which is not published, and only recognises common test runners and plain
claims; a hedged or unusual claim passes unchecked.

`sous fleet [DIR]` lists every worktree of the repo, read-only: branch,
dirty, ahead/behind the base, how many tests the last log ran, guard blocks
under that path, and scoped claims. Bare, detached and prunable worktrees are
listed without reading a working tree they lack.

## Why a hook when there are deny rules

`Bash(...)` deny rules match the command text, not the program, so `/bin/rm`,
`sh -c '...'` and `git -C dir push` walk past them. Deny rules catch the common
spelling, `sous-guard.sh` catches the rest, and the OS sandbox is the boundary.
None of the three is enough alone. The guard ignores heredoc bodies (a commit
message that mentions `rm -rf`) unless the heredoc feeds an interpreter
(`bash <<EOF`). It is a text matcher: what it can't
see is listed under known gaps in [SECURITY.md](SECURITY.md), each asserted by
a test.

## iOS / Xcode

`xcodebuild` nests its own sandbox and can't run inside Claude Code's.
`install --ios` (auto-detected from `*.xcodeproj`, `*.xcworkspace`,
`Package.swift`) excludes the Xcode toolchain from the sandbox. An exclusion
only applies when it covers every command in a compound call, so
`cd ios && xcodebuild` stays sandboxed: call the tool or wrapper directly.

## Development

[CONTRIBUTING.md](CONTRIBUTING.md) has the test commands. None of the suites
touch your `~/.claude` or the network. `sous marketplace-check` verifies that
every pinned plugin ref in `.claude-plugin/marketplace.json` resolves to its
sha (exit 75: a remote was unreachable). [`evals/`](evals) holds
`claude plugin eval` cases; they run real sessions, so CI skips them.

MIT licensed.
