---
description: List written prohibitions in CLAUDE.md that no deny rule or guard check enforces
argument-hint: "[--fix] [--dry-run]"
allowed-tools: Bash(sous lint:*)
---

Run `sous lint` in the project root. Show the unenforced prohibitions verbatim, with the
rule each one would add. Do not pass `--fix` unless the user asked for it; run it with
`--dry-run` first and show the rules before writing them.
