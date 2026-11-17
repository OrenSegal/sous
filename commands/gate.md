---
description: Check that the current branch is safe to merge, one named check at a time
argument-hint: "[--base REF] [--transcript=FILE.jsonl]"
allowed-tools: Bash(sous gate:*), Bash("${CLAUDE_PLUGIN_ROOT}/bin/sous" gate:*)
---

Run `"${CLAUDE_PLUGIN_ROOT}/bin/sous" gate $ARGUMENTS` in the project root. Report the verdict line, then each
FAIL and warn with its `fix:` line verbatim. Do not run a fix yourself, and do not
pass `--ack-blocks` unless the user reviewed the blocks and asked for it.
