---
max_turns: 8
allowed_tools: [Read, Grep, Glob, Bash, Agent, Skill]
---

Use /brigade:route to plan this task and show the route table. Do not make the change.

Task: in `src/auth/session.ts`, shorten the refresh-token lifetime from 30 days to 7 days and make old tokens fail on next use.
