# Security

sous is a guard, so a bypass is a security bug.

- Report a vulnerability through GitHub's private advisory form on this repo, not a public issue.
- In scope:
  - a command that does what a guard rule exists to stop (recursive force delete, force push, reading a secrets file, fetch piped into a shell, a Bash write to `.claude/settings*.json`, `.claude/hooks/` or `.mcp.json`) and still passes `hooks/sous-guard.sh`
  - an `install` or `upgrade` that edits `~/.claude` or removes an existing rule
  - an `uninstall` that removes a rule, key or file sous didn't add
- Out of scope, and documented as known gaps (each is a `check 0` row in `tests/adversarial.test.sh`, so the docs go red if that changes):
  - commands built at runtime: `r=rm; $r -rf x`, `f=.env; cat $f`, `$(echo rm) -rf build`. No text matcher can see through a variable.
  - paths reached through a `cd`: `cd ~ && cat .ssh/id_rsa`
  - a script written first and run second: a heredoc into `x.sh` then `bash x.sh`, or `curl ... -o x.sh && bash x.sh`
  - harness files written through a path the text doesn't spell out: `p=.claude/settings.json; echo {} > $p`, the same variable inside `python -c`, `cd .claude && echo {} > settings.json`, `os.path.join('.claude', 'settings.json')`, and `cp /tmp/evil/.mcp.json .` (a copy into a directory, keeping a source name the rule exempts as a temp-dir fixture). Harness paths under `/tmp`, `/private/tmp`, `/var/folders` or `$TMPDIR` are exempt on purpose, so test fixtures can be written.
  - harness files written by applying a patch: `git apply` or `patch -p1 <` with a patch whose hunks touch `.claude/settings.json`, `.claude/hooks/` or `.mcp.json` (the handoff mod's `LATEST.patch` carries such hunks when the tree has them). The targets are inside the patch file, not in the command text the tamper rule reads. Read the patch's file list before applying it.

  The OS sandbox (write scope, `denyRead`, network allowlist) is the boundary for those, and `sous doctor` checks it is on.
- Unverified: Claude Code's docs say the `Edit(...)` deny rules `install` adds also stop Bash redirects and `tee` into those paths. sous has not checked that in a live session, so the guard blocks those spellings itself.
- Threat model: sous protects against a well-meaning agent doing something destructive. It is not a defense against a hostile process already running as you.
