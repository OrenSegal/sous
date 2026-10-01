---
description: Show what the sous guard blocked recently and how to tune it
argument-hint: "[--days=N]"
allowed-tools: Bash(sous report:*)
---

Run `sous report $ARGUMENTS`. Group the reasons into likely false positives and likely
real attempts. Do not change the guard or its test tables; propose the `check 0` or
`check 2` row for each case and let the user decide.
