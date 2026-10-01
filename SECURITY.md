# Security

sous is a guard, so a bypass is a security bug.

- Report a vulnerability through GitHub's private advisory form on this repo, not a public issue.
- In scope: a command that does what a guard rule exists to stop (recursive force delete, force push, reading a secrets file, fetch piped into a shell) and still passes `hooks/sous-guard.sh`; an `install` that edits `~/.claude` or removes an existing rule.
- Out of scope, and documented: commands built at runtime (`r=rm; $r -rf x`). No text matcher can see through a variable. The OS sandbox is the boundary for those, and `sous doctor` checks it is on.
- Threat model: sous protects against a well-meaning agent doing something destructive. It is not a defense against a hostile process already running as you.
