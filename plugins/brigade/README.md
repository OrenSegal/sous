# brigade

A kitchen brigade gives every cook one station and one standard. brigade does the same for coding agents: it decides which model does each piece of work, says what proves the work is done, and makes sure each mistake is made only once.

`sous` guards what an agent may run. brigade organizes what it should do.

## Why

A strong model looks fast because it quietly fills in whatever the instructions left out. A cheap model can't, so every gap becomes a mistake. Most teams answer that by running the strong model on everything. brigade answers it by closing the gaps: a failing test, a reference file, a command that says pass or fail. Once a task is that concrete, a cheaper model does it just as well.

## What's inside

| Part | What it does |
|---|---|
| [`routing.md`](routing.md) | The one table of tiers (haiku, sonnet, opus, and fable as the lead), roles, workflow pipelines and escalation triggers |
| `agents/` | `scout` (find), `builder` (change), `verifier` (prove), `reviewer` (fresh eyes). Their models come from `routing.md`, and the tests fail if they drift |
| `skills/route` | Turns a task into stages, each with an agent, a tier and the evidence that ends it |
| `stacks/` | A verify ladder, a done list, a review list and product and design checks for iOS, web, API and data work |
| `skills/compound` | After a fix, keeps the lesson in its cheapest lasting form: a test, then a lint rule, then a standard, then a note |
| `skills/retro` | Reads past sessions, finds what keeps costing the agent effort, and proposes fixes backed by that evidence |
| `skills/writing-skills` | Write a skill the way you write code: watch it fail without the skill, then make it pass |
| `templates/config.yaml` | Per-repo stack commands, protected paths and file names |

`compound` and `retro` come from Every's [compound-engineering](https://github.com/EveryInc/compound-engineering-plugin). `writing-skills` comes from Jesse Vincent's [superpowers](https://github.com/obra/superpowers). Names and paths were adjusted; the method is theirs. See [NOTICE](NOTICE).

## Install

```bash
claude plugin marketplace add OrenSegal/sous
claude plugin install brigade@sous
```

Then copy `templates/config.yaml` to `.brigade/config.yaml` in your repo and fill in the commands each stack really uses.

## How a task runs

1. `/brigade:route` names the workflow (feature, bug fix, refactor, UI, API, migration, research, audit, release) and the stacks it touches.
2. Each stage goes to the tier in `routing.md`. A stage goes to a cheap model only when it has a test or a reference file to work from.
3. `verifier` runs the stack's ladder and reports each command with its exit code and executed test count.
4. `reviewer` reads a diff it did not write.
5. `compound` keeps what you learned. `retro` looks across sessions once a week.

A stage moves up a tier when its checks fail twice, when it touches a protected path, when it crosses a boundary the plan didn't name, or after three rounds. It moves down a tier only when retro or a benchmark shows the cheaper model passing the same checks.

## Projects with their own agents

Keep them. Map each one to a tier in your own docs and use brigade's agents for anything unmapped. Don't run both on the same stage.

## Cost

Every session pays only for the listing: the names and descriptions of four skills and four agents, about 2.4 KB (roughly 600 tokens). A skill or agent body loads only when it runs. `route` is 2.3 KB, each agent about 1 KB, and `routing.md` plus one stack file about 5 KB.

## Limits

- The stack profiles are starting points. The iOS profile comes from a working Swift project. The web, API and data profiles have not yet run on a real project. The commands in your `.brigade/config.yaml` decide what runs.
- The routing tiers are defaults, not measurements. Your own retro and benchmark results should move them.
- Plugin agents read their `model:` line unless `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is set, which overrides it.

## Development

```bash
./tests/run.sh
claude plugin validate . --strict
```
