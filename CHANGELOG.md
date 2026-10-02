# Changelog

## Unreleased

- litmus is retired from the marketplace and the toolkit table: its deterministic assertions can pass when they could never fail, and `claude plugin eval` covers the rest.
- New `sous lint [DIR] [--fix] [--dry-run]`: lists written prohibitions in `CLAUDE.md` / `AGENTS.md` that no rule or guard check enforces; `--fix` adds deny rules through the manifest. It reads every prohibition on a line, not the alternative after "use X instead" or "never skip X", and needs an `Edit` rule (not only a `Read` rule) to call "never edit" enforced.
- New `compile [DIR] [--to=agents|cursor|copilot] [--write|--remove]`: the deny rules as instructions for agents that don't read `settings.json`. `--write` keeps the file's mode, writes through a symlinked `AGENTS.md`, and refuses (exit 1, file untouched) when the markers are not one begin/end pair or `.cursor/rules/sous.mdc` exists without one.
- handoff mod: `LATEST.patch` leaves out secret-looking files at the repo root too (`server.key`, `private.pem`, `secrets.yml`, `credentials.json` were written), and is rewritten when an edit leaves the diffstat unchanged. CI validates and tests the mod.
- `lint` and `doctor` scan memory files, skills, commands, agents and `.mcp.json` for hidden characters and instruction-dropping lines (`--strict` fails on a hit).
- The hidden-instruction scan also reads `CLAUDE.local.md`, nested `CLAUDE.md` files (not under dot directories or `node_modules`) and `.claude/rules/`, and flags U+200E/F, U+00AD, U+061C, U+180E, U+2061-2064, U+3164, variation selectors U+FE00-FE0D and U+E0100-E01EF, and runs of U+FE0E/FE0F (a lone one is emoji presentation and passes). A drop/hide/HTML-comment phrase quoted in a fence, inline code or quotes within a sentence passes, as does a curl `$TOKEN` in a header or `-u` argument; network sends still count inside fences.
- handoff mod 0.1.1: `LATEST.patch` also leaves out `id_rsa*`, `.npmrc`, `.netrc`, `service-account*.json`, `*.p12` and `*.pfx`; carries binary changes (`git diff --binary`); over the 300000-character cap it stops at a file boundary (a hunk boundary when one file is over), and says in a trailing comment and in `LATEST.md` what it left out. SECURITY.md lists applying a patch with harness hunks as a known gap.
- Guard block reasons are fixed text and no longer quote the command's program, path or glob (`cat touches .env.prod` is now "the command names .env or a variant"), so neither the agent's message nor `blocks.tsv` carries a word of the command. Different `.env` spellings now share one reason, so the loop breaker counts them together. The loop breaker says "Blocked at least N times for the same reason in the last two minutes", not "in a row".
- `compile --write` and `--remove` keep a CRLF file's line endings, and write sous's block in CRLF there.
- `report` shows a block rate; the guard counts allowed commands as bytes in `blocks.tsv.allowed.YYYYMMDD`, never their text.
- Guard: the third identical block from the same project within two minutes tells the agent to stop retrying; blocks in other sessions sharing the log no longer count. Allowed commands are counted before the first block creates the log directory.
- New `bin/tests-weakened`: flags a diff that deletes, skips or loosens tests (heuristic). It reads a diff on stdin, or diffs from the merge base with a ref, so tests the base gained later don't read as deleted; an unknown ref exits 2.
- `probe --record` also fingerprints `.mcp.json` servers and enabled plugins; doctor notes drift (`--strict` fails) and names servers run by `npx`, `bunx`, `pnpx`, `uvx` or `pipx` without a version pin, or over plain http.
- New `sous accept [DIR]`: records each enabled plugin's surface (hook commands, files under `hooks/` and `bin/` or named by a hook, MCP servers, the `allowed-tools` its commands, agents and skills ask for) next to the `.mcp.json` servers. Doctor names each item added, removed or changed since, so a same-version edit to a hook script shows; gate warns (`tools-drift`). Only `accept` moves the record: `probe --record` seeds a first one and otherwise leaves it alone. The guard blocks `sous accept` from Bash, so a session cannot clear its own drift report; the user runs it.
- `sous gate` checks release notes when the repo has a `CHANGELOG.md`: a version bumped in `.claude-plugin/plugin.json` or `package.json` with no `## <version>` heading fails; a change under `bin/`, `commands/`, `hooks/` or `skills/` with no new CHANGELOG line warns.
- The base template deny-lists `Edit` on `.claude/settings*.json`, `.claude/hooks/**` and `.mcp.json`; doctor fails when one is missing (`upgrade` adds them).
- New `sous gate [DIR] [--base REF] [--json]`: exit 0 only when the branch is safe to merge (clean, pushed, tests ran after the last edit and were not weakened, no unacknowledged guard blocks in this worktree since the fork, doctor passes, scoped claims, worktree settings drift as a warning). `--transcript=FILE.jsonl` checks the final message's test claims against the tool calls; `--ack-blocks` records that the blocks were reviewed.
- New `sous fleet [DIR] [--json]`: every worktree with branch, dirty, ahead/behind, tests ran, blocks and scoped claims. Read-only.
- The guard logs the project directory as a third column of `blocks.tsv`, so gate and fleet can tell worktrees apart; rows from older guards still count in `sous report`. Run `sous upgrade` to refresh vendored copies.
- `tests/rules.test.sh` pairs every guard rule with a block and an allow fixture and fails on a guard message with no pair.
- The guard blocks Bash writes to `.claude/settings*.json`, `.claude/hooks/` and `.mcp.json`: redirects, `tee`, `cp`/`mv`/`install`/`ln`, `sed -i`/`perl -i`, `dd of=`, `rm`/`chmod`/`truncate`, and interpreter write calls naming the path. Reads, git and temp-dir fixtures pass; a path held in a variable or reached after `cd` is listed as a gap in SECURITY.md.

## 0.3.0

Guard (`hooks/sous-guard.sh`):
- Closes 55 bypasses found in an audit and 2 false positives; the red-team corpus grows from 92 to 216 cases.
- Heredoc scanning is quote-aware, and block messages expand the matched path.
- Long inputs no longer stall bash 3.2 (a 20KB one-liner took about 40s).
- Carries `SOUS_GUARD_VERSION`, so doctor can tell an old copy from an edited one.

`sous`:
- New `uninstall [DIR] [--dry-run]`, backed by `.claude/sous.manifest.json`: it removes only what install recorded adding and restores values `--strict` overrode. `upgrade` is install under another name.
- New `marketplace-check [REPO] [--offline] [--timeout=S]`: each pinned ref must resolve to its sha (`git ls-remote`); exit 75 when the network is unreachable.
- New `probe --record DIR`, which notes that the live probe held for the current settings.
- New `--version`, read from `plugin.json`, the one place the version is written.
- Settings parse defensively: JSONC is read but not rewritten, and a BOM, a broken file or a non-object top level gives a message instead of a traceback. Writes are atomic and follow symlinks. Unknown flags exit 64.

Doctor:
- Layers `settings.local.json` over `settings.json`.
- Finds hooks behind quoted paths, spaces, variables and matchers, and checks every interpreter argument for dead rules.
- Fails when the guard runs twice (project, user, or an enabled sous plugin) and says which one to keep.
- Checks plugin `hooks.json` targets, CRLF guards and version drift.
- `--strict` also fails when the host can't run the sandbox, or when there is no live probe record for the current settings.
- The table cache key covers bash and jq, its contents are validated, and CI ignores it by default (`SOUS_TABLE_CACHE`).

Repo:
- The README opens with the toolkit table (sous, litmus, cited, scoped), and tests keep it, the marketplace description, the demo capture and the version in step.
- CI adds ruff, `plugin validate` for skills, and a marketplace job that warns, not fails, on network errors.
- Adds a release workflow, CONTRIBUTING, a code of conduct, issue templates and eval cases.

## 0.2.0

- Plugin commands `/sous:install`, `/sous:doctor`, `/sous:report` and the `sous-reviewer` agent.
- `SessionStart` hook backed by the new `sous check`, a fast presence check for layers 3 and 5.
- The marketplace lists cited (renamed from verify-before-ship) and scoped.
- CI validates the plugin manifest, commands, agents and marketplace.
- SECURITY.md and a recorded demo (`docs/demo.sh`).

## 0.1.0

- Five-layer harness, `sous-guard.sh`, doctor, report, probe, `test-audit` and `tests-ran`.
