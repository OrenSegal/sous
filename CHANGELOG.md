# Changelog

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
