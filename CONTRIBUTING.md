# Contributing

Bypasses are security bugs: report them privately (see [SECURITY.md](SECURITY.md)), not in an issue or PR.

## Red first

Every behavior change starts as a test that fails:

- **A new bypass** gets a `check 2 '<command>'` row in `tests/adversarial.test.sh`. Run the suite and see it fail, then fix `hooks/sous-guard.sh`.
- **A new guard rule** gets a row in `tests/rules.test.sh` (a command it blocks, a near-miss it allows); that suite fails if a guard message has no row.
- **A false positive** gets a `check 0 '<command>'` row the same way.
- **A known gap** the guard can't close stays a `check 0` row under `KNOWN_GAP`, and SECURITY.md lists it.
- **A `sous` change** gets a case in `tests/install.test.sh` (`gate.test.sh` / `fleet.test.sh` for those commands) that fails against the old `bin/sous`. A new gate check is one `@gate_check` function in `bin/sous` plus its cases in `tests/gate.test.sh`. New features with no need for sous's settings helpers go in `lib/sous_<name>.py` as pure functions; `bin/sous` keeps only the glue.

A test that passes before the fix doesn't prove the fix.

## Run everything

```bash
bash tests/sous-guard.test.sh
bash tests/adversarial.test.sh
bash tests/rules.test.sh          # every guard rule has a block and an allow fixture
bash tests/tests-ran.test.sh
bash tests/tests-weakened.test.sh
bash tests/install.test.sh        # about 2 minutes; temp HOME, no network
bash tests/gate.test.sh           # throwaway repos and worktrees; temp HOME
bash tests/fleet.test.sh
shellcheck -S warning hooks/*.sh bin/tests-ran bin/tests-weakened docs/demo.sh tests/*.sh
ruff check bin/sous lib           # settings in ruff.toml
claude plugin validate . --strict
claude plugin eval . --allow-tools Bash --runs 3   # optional: real sessions, costs money; CI skips it
```

On macOS, also run the table suites under `/bin/bash` (3.2). The guard
must work there, so avoid bash 4+ features such as `${var,,}`, `mapfile` and
associative arrays. CI runs bash 5 on Linux and 3.2 on macOS.

## Rules

- Tests never touch the real `~/.claude` or the network. Use the temp `HOME` helpers in `tests/install.test.sh`, and a local git remote for marketplace checks.
- `install` and `upgrade` stay additive. Anything they add goes through `merge()`, so the manifest records it and `uninstall` can reverse it.
- The guard never logs command text, only a timestamp and a reason.
- If you change a guard message, regenerate the demo with `bash docs/demo.sh > docs/demo.txt` and paste it into the README block; `tests/install.test.sh` fails until both match.
- The version lives only in `.claude-plugin/plugin.json`. Add a line under that version in CHANGELOG.md; the release workflow publishes that section when the tag is pushed.
