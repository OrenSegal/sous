---
name: route
description: Turn a task into a pipeline of stages, each with a model tier, an agent and the evidence that ends it. Use at the start of any task bigger than one file, when unsure which model or agent should do a piece of work, or when a worker is failing and you need to decide whether to escalate.
---

# Route

Read `routing.md` in this plugin before you route. It owns the tiers, the roles, the workflow types and the escalation rules. This skill only applies them.

## Steps

1. **Name the workflow.** Pick one row from the workflow table in `routing.md`. If the task spans two (a feature with a migration), split it into two pipelines and order them.
2. **Find the stacks.** Read `<repo-root>/.brigade/config.yaml`. Match the paths the task will touch against each stack's `paths`. Read `stacks/<profile>.md` in this plugin for each match. No config: infer the stack from the files and say the commands are guesses.
3. **Check protected paths.** If the task touches a path under `protected:` in the config, or the stack profile's review list names it, the leader owns that stage and a `reviewer` reads the diff.
4. **Make each stage concrete before you delegate it.** A stage goes to `builder` only when it has a failing test or a reference file. A stage goes to `scout` only when the question has a searchable answer. If you cannot make it concrete, it stays with you.
5. **Write the route** as a short table: stage, agent, tier, input, exit evidence. Keep it in the plan, not in a new file.
6. **Run it.** After each stage, check its exit evidence before starting the next. Apply the escalation list in `routing.md` the moment one of its triggers happens.
7. **Close with learning.** After the last stage, run `compound` on anything that surprised you. Run `retro` after a session that cost more than it should have.

## Project lanes

If the project already defines agents for these jobs (in `.claude/agents/`), use those and map each to a tier in the project's docs. Do not run both a project lane and a brigade agent on the same stage.

## Do not

- Do not route on a worker's self-reported confidence.
- Do not spawn a subagent on fable; use opus for T3 and keep T4 work in the session.
- Do not fan out before one item has gone through the whole pipeline.
