# sous

A Claude Code harness you can install in one command, and a doctor that
proves it still holds.

Agent = model + harness. The model is rented; the harness is yours. sous
packages the harness as five layers, each backed by a file Claude Code
already reads, and checks every layer on demand or in CI:

| Layer | What holds it | sous adds |
|---|---|---|
| 1 Memory | `CLAUDE.md` / `AGENTS.md` | presence check |
| 2 Tools | `.mcp.json`, plugins | reported |
| 3 Permissions + sandbox | `.claude/settings.json` `permissions` + `sandbox` | deny `.env` read/edit, recursive force delete, force push; OS sandbox on with a network allowlist |
| 4 Hooks | `PreToolUse` | `sous-guard.sh`: hard stops for the spellings deny rules miss (`/bin/rm -rf`, `sh -c`, `git -C . push -f`, `cat .env`) |
| 5 Human gates | `permissions.ask`, user settings | push / commit / PR / unsandboxed retry ask first; bypass mode disabled |

Plus one skill: [`test-audit`](skills/test-audit/SKILL.md), which gates new
tests on the behavior they prove and makes deletions show evidence.

And one CI check: [`bin/tests-ran`](bin/tests-ran) reads a test log and exits 1
when it shows zero executed tests. `xcodebuild` prints `** TEST SUCCEEDED **`
and exits 0 when a filter matches nothing, and pytest, Vitest and Jest stay
green when every test is skipped, so the status line alone can't be trusted.
It reads XCTest, Swift Testing, pytest, Vitest and Jest output, and takes
`--min N` for a floor. It reports the largest count it finds, not a sum, so
treat it as a zero-detector and not a coverage number.

## What it looks like

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

Platforms: macOS and Linux. The guard is bash and the doctor is Python 3; on
Windows use WSL.

## Install

```bash
git clone https://github.com/OrenSegal/sous ~/.sous
~/.sous/bin/sous install /path/to/project --dry-run   # see what changes
~/.sous/bin/sous install /path/to/project
~/.sous/bin/sous doctor  /path/to/project
```

`install` is additive only: lists gain missing entries, existing scalar values
are kept and reported. It never edits `~/.claude`; it prints the one user-scope
line to add yourself:

```json
{ "permissions": { "disableBypassPermissionsMode": "disable" } }
```

This repo is also a plugin marketplace. `claude plugin marketplace add
OrenSegal/sous` lists sous, litmus, cited and scoped, and
`claude plugin install sous@sous` installs the plugin. It carries:

| Piece | What it does |
|---|---|
| `sous-guard.sh` `PreToolUse` hook | the hard stops for Bash |
| `SessionStart` hook | runs `sous check`, one line, silent when layers 3 and 5 are present |
| `/sous:install` | previews, asks, then applies permissions, sandbox and ask gates |
| `/sous:doctor`, `/sous:report` | run the doctor and the block report and explain the result |
| `sous-reviewer` agent | turns doctor failures and false positives into the smallest change |
| `test-audit` skill, `tests-ran` | see above |

The plugin's `bin/` goes on PATH, so `sous` and `tests-ran` run as bare commands.
A plugin can't set permissions or the sandbox, so layers 3 and 5 still need
`/sous:install` (or `sous install`); with both, the guard runs twice, which is
harmless.

Bypass mode skips every `ask` gate, so layer 5 is only real with it off.
`auto` mode stays available.

For unattended runs add `--strict`. It sets `sandbox.allowUnsandboxedCommands`
to `false`, so a command the sandbox blocks fails instead of retrying outside
the sandbox. Only `excludedCommands` still run unsandboxed.

## Bloat, rot and the feedback loop

A harness that nobody maintains decays into one that blocks the wrong things.
`sous doctor` fails on each of these:

| Check | Why |
| --- | --- |
| a memory file over 400 lines (`SOUS_MEMORY_LINES`) | it loads on every turn |
| a duplicate allow/ask/deny rule | noise that hides intent |
| an allow/ask rule naming a script that no longer exists | a renamed script loses its rule without anyone seeing |
| a guard slower than 500ms (`SOUS_GUARD_MS`) | it runs before every Bash call |
| a stale copied guard | `sous install` refreshes it |

Doctor caches passing table results by content hash, so it reruns the 100+
cases only after the guard or the tables change.

The guard appends every block to `~/.claude/sous/blocks.tsv` as a timestamp and
a reason, never the command text, since commands can hold secrets. Set
`SOUS_LOG=off` to disable it. `sous report` counts blocks by reason and says
how to act on them:
- A false positive becomes a `check 0` row.
- A new bypass becomes a `check 2` row that fails first.
- A rule that never fires is a deletion candidate.

The known-gap rows keep the docs honest. If the guard ever starts blocking one
of them, the corpus goes red and the docs get revisited.

`sous probe` prints red-team prompts to paste into a fresh session. The sandbox
is part of Claude Code's runtime, not a file, so only a live session can prove it.

## Why a hook when there are deny rules

`Bash(...)` deny rules match the command text, not the program. The docs say
so: `/bin/rm`, `sh -c '...'` and `git -C dir push` walk straight past them.
They catch the common spelling; `sous-guard.sh` catches the rest; the OS
sandbox is the actual boundary. None of the three is enough alone.

The guard ignores heredoc bodies (a commit message that mentions `rm -rf`)
unless the heredoc feeds an interpreter (`bash <<EOF`, `cat <<EOF | sh`).

## iOS / Xcode

`xcodebuild` runs its own nested sandbox and can't run inside Claude Code's.
`install --ios` (auto-detected from `*.xcodeproj`, `*.xcworkspace`,
`Package.swift`) excludes the Xcode toolchain from the sandbox; everything
else stays sandboxed. Add your own build wrappers to `excludedCommands`.
An exclusion only applies when it covers every command in a compound call,
so `cd ios && xcodebuild` stays sandboxed: call the tool or wrapper directly.

Which harness for which work:

| Work | Harness |
|---|---|
| Interactive, on your Mac | Seatbelt sandbox + Xcode exclusions (this repo) |
| Unattended iOS agent loops | one macOS VM per agent ([Tart](https://github.com/cirruslabs/tart)); a 16GB host fits about one |
| Web, backend, edge functions | Docker / devcontainer; Linux-only, can't run Xcode |

## Companion tools

sous is the per-session seatbelt. These solve adjacent problems and compose
with it rather than living inside it:

- [scoped](https://github.com/OrenSegal/scoped): file claims between
  concurrent sessions, enforced by its own `PreToolUse` hook.
- [litmus](https://github.com/OrenSegal/litmus): red/green CI for skills and
  prompts; a green only counts if it could have failed.
- [cited](https://github.com/OrenSegal/cited):
  checks cited claims against their source pages.

## Test

```bash
bash tests/sous-guard.test.sh     # 35-case table, bash 3.2 compatible
bash tests/adversarial.test.sh    # 92-case red-team corpus + block-log contract
bash tests/install.test.sh        # install/strict/dry-run into temp projects, doctor passes
bash tests/tests-ran.test.sh      # 35-case table: zero-test greens, skips, mixed harnesses
```

`sous doctor` runs both guard suites against the hook that Claude Code will
actually call, not against sous's own copy.

The red-team corpus covers these bypass attempts:
- delete spellings: `/bin/rm`, split flags, `--recursive --force`, `git clean -f`, `find -delete`, `rsync --delete`
- push variants: `+ref`, `:ref`, `--mirror`, `-fd`
- secret readers: redirects, globs, copies, python/node, `source`, `~/.ssh`
- decode or fetch piped into a shell, and process substitution
- malformed hook input, which fails closed
- a 5000-line heredoc, which must finish under 5s

**Known gaps, asserted in the corpus rather than hidden.** Commands built at
runtime pass the guard, for example `r=rm; $r -rf x` or `f=.env; cat $f`. No
text matcher can see through a variable. The OS sandbox is what stops those,
so keep it on.

Reference install: a private iOS app repo runs the
same guard inside its larger `bash-pretool.sh`, with `sous.sh doctor` wired
into its tooling CI.

MIT licensed.
