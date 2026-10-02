---
description: Write this project's deny rules as instructions for AGENTS.md, Cursor or Copilot
argument-hint: "[--to=agents|cursor|copilot] [--write|--remove]"
allowed-tools: Bash(sous compile:*)
---

Run `sous compile $ARGUMENTS` in the project root. With no `--write` it only prints; show the
output and say which file `--write` would change. Do not pass `--write` or `--remove` unless
the user asked. Remind them that other agents read this as a request and only Claude Code
enforces the deny rules.
