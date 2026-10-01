---
description: Preview and apply the sous permissions, sandbox and ask gates for this project
argument-hint: "[--ios] [--strict]"
allowed-tools: Bash(sous install:*)
---

A plugin can't set permissions or the sandbox, so this command does it.

1. Run `sous install . --dry-run $ARGUMENTS` and show the list of changes.
2. Ask the user to confirm. Do not continue without a yes.
3. Run `sous install . $ARGUMENTS`, then `sous doctor .`.
4. Print the one `~/.claude/settings.json` line the installer asks the user to add.
   Never edit anything under `~/.claude` yourself.
