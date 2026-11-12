# Security

sous is a guard, so a bypass is a security bug.

- Report a vulnerability through GitHub's private advisory form on this repo, not a public issue.
- In scope:
  - a command that does what a guard rule exists to stop (recursive force delete, `git reset --hard`, force push, reading a secrets file, `gh auth token`, fetch piped into a shell, a Bash write to `.claude/settings*.json`, `.claude/hooks/` or `.mcp.json`) and still passes `hooks/sous-guard.sh`
  - an `install` or `upgrade` that edits `~/.claude` or removes an existing rule
  - an `uninstall` that removes a rule, key or file sous didn't add
- Out of scope, and documented as known gaps (each is a `check 0` row in `tests/adversarial.test.sh`, so the docs go red if that changes):
  - commands built at runtime: `r=rm; $r -rf x`, `f=.env; cat $f`, `$(echo rm) -rf build`. No text matcher can see through a variable.
  - paths reached through a `cd` into a directory the rules don't name: `cd ~/.config/gh && cat hosts.yml`
  - recursive reads, on purpose: `grep -r "" .` prints every file under the directory, secrets included, but it names none of them, and blocking it would block `grep -r`, the most common search there is. `denyRead` in the sandbox is the control. The same holds when a secret is named only in a listing that is piped to a reader naming no path, `ls .env | xargs cat`: the reader never sees the name, and blocking it would block `ls | xargs`.
  - credential files outside the list. The guard knows `.env*`, `.ssh`, `.aws`, `.gnupg`, `.kube` and `.netrc`, and `gh auth token`. It does not know `~/.config/gh/hosts.yml`, `~/.npmrc` or `~/.docker/config.json`.
  - a script written first and run second: a heredoc into `x.sh` then `bash x.sh`, or `curl ... -o x.sh && bash x.sh`
  - harness files written through a path the text doesn't spell out: `p=.claude/settings.json; echo {} > $p`, the same variable inside `python -c`, `cd .claude && echo {} > settings.json`, `os.path.join('.claude', 'settings.json')`, and `cp /tmp/evil/.mcp.json .` (a copy into a directory, keeping a source name the rule exempts as a temp-dir fixture). Harness paths under `/tmp`, `/private/tmp`, `/var/folders` or `$TMPDIR` are exempt on purpose, so test fixtures can be written.
  - harness files written by applying a patch: `git apply` or `patch -p1 <` with a patch whose hunks touch `.claude/settings.json`, `.claude/hooks/` or `.mcp.json` (the handoff mod's `LATEST.patch` carries such hunks when the tree has them). The targets are inside the patch file, not in the command text the tamper rule reads. Read the patch's file list before applying it.
  - a quote opened before a `git` or `jq` command, so that what the guard hides as a commit message or filter is code to bash: `echo '; git commit -m ' ; rm -rf x ; echo ' y'`. It takes a crafted command, not a slip, and it should be closed; the fix has to keep `cd "$d" && git commit -m "drop rm -rf"` working.
  - `rsync --remove-source-files`, and `git config clean.requireForce false` followed by a plain `git clean -d` in a later command.

  The OS sandbox (write scope, `denyRead`, network allowlist) is the boundary for those, and `sous doctor` checks it is on.
- Known false positive: naming a credentials path is blocked even when the program only uses it, as with `kubectl --kubeconfig ~/.kube/config get pods` or `ssh -i ~/.ssh/key host`. Leave the flag off, or ask the user.
- Limits: the guard blocks a command over 64KB, over 32KB outside heredoc bodies, with more than 512 path or command matches, or with more than 2048 commands on a line. A command it has not read must not run. Past those limits it answers in seconds; bash 3.2 regex and string work is what it would otherwise spend the time on.
- Timeouts: Claude Code's hook docs say a `PreToolUse` command hook that times out or crashes does not block the call, unless the hook sets `onFailure: "block"` (2.1.295 and later). `hooks/hooks.json` and `templates/settings.base.json` set that with a 30-second timeout. On an older Claude Code, a timed-out guard lets the command through. A project installed before this change keeps its old hook entry until you edit it. sous has not checked either behavior in a live session.
- Unverified: Claude Code's docs say the `Edit(...)` deny rules `install` adds also stop Bash redirects and `tee` into those paths. sous has not checked that in a live session, so the guard blocks those spellings itself.
- Threat model: sous protects against a well-meaning agent doing something destructive. It is not a defense against a hostile process already running as you.
