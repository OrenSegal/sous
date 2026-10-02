# Security

sous is a guard, so a bypass is a security bug.

- Report a vulnerability through GitHub's private advisory form on this repo, not a public issue.
- In scope:
  - a command that does what a guard rule exists to stop (recursive force delete, force push, reading a secrets file, fetch piped into a shell) and still passes `hooks/sous-guard.sh`
  - an `install` or `upgrade` that edits `~/.claude` or removes an existing rule
  - an `uninstall` that removes a rule, key or file sous didn't add
- Out of scope, and documented as known gaps (each is a `check 0` row in `tests/adversarial.test.sh`, so the docs go red if that changes):
  - commands built at runtime: `r=rm; $r -rf x`, `f=.env; cat $f`, `$(echo rm) -rf build`. No text matcher can see through a variable.
  - paths reached through a `cd`: `cd ~ && cat .ssh/id_rsa`
  - a script written first and run second: a heredoc into `x.sh` then `bash x.sh`, or `curl ... -o x.sh && bash x.sh`
  - an interpreter rewriting the harness: `python3 -c "open('.claude/settings.json','w')..."`. The `Edit(...)` deny rules on `.claude/settings*.json`, `.claude/hooks/**` and `.mcp.json` cover Edit, Write and shell redirects, not code that opens the file itself

  The OS sandbox (write scope, `denyRead`, network allowlist) is the boundary for those, and `sous doctor` checks it is on.
- Threat model: sous protects against a well-meaning agent doing something destructive. It is not a defense against a hostile process already running as you.
