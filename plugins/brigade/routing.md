# Routing

This file is the one place that says which model does which work. The `model:` line in each file under `agents/` must agree with it; `tests/run.sh` fails when they differ.

## The rule

A strong model is fast because it covers for what the harness left vague. A cheap model cannot, so it crashes on every gap. Cheap models are safe only on work the harness has already made concrete: a recipe to follow, a reference file to copy, a command that says pass or fail. Close the gap in code, then move the work down a tier.

Two consequences:

1. **Route by how concrete the task is, not by how important it is.** A one-line change to auth is not concrete. A 40-file rename with a codemod is.
2. **Escalate on things you can observe, never on a worker's own confidence.** A worker that rates itself 0.9 is not calibrated. A red verify lane is.

## Tiers

| Tier | Model | Gets work that is | Never gets |
|---|---|---|---|
| T0 | no model | deterministic: a script, a codemod, a gate | anything that needs a choice |
| T1 | haiku | concrete and read-mostly: locate, summarize a file, triage a log, copy a reference file's shape | edits to existing files, safety, auth, payments, data deletion |
| T2 | sonnet | concrete and bounded: a change with a test or a reference, a doc patch, running a verify lane and reporting evidence | decisions the spec leaves open |
| T3 | opus | open but bounded: multi-file work in a hard domain, review with fresh eyes, adversarial checks of a claim | the final call on architecture or risk |
| T4 | fable, or the session's own model | the leader: plan, architecture, root cause, anything touching money, auth, user data or safety, and the final review | bulk reading, which it delegates |

Fable is a leader and advisor tier. Do not spawn subagents on it; route a subagent to opus when it needs T3 or more.

## Roles

| Agent | Tier | Tools | Job |
|---|---|---|---|
| `scout` | T1 | read-only | find where something lives; return `file:line`, not conclusions |
| `builder` | T2 | edit | make one bounded change that a test or a reference file pins; run the stack's fast check |
| `verifier` | T2 | read, run | run the stack's verify ladder and report each rung with its exit code |
| `reviewer` | T3 | read-only | review a diff it did not write, against the stack profile and the spec |

Planning has no agent. Use the session's plan mode: the plan belongs to the leader, and a plan agent with edit tools is how plans drift into code.

A project that already has its own lanes keeps them. Map each lane to a tier in the project's own docs and treat this table as the default for anything unmapped.

## Workflow types

Each row is a pipeline. Run the stages in order; a stage starts only when the one before it left evidence.

| Workflow | Stages (tier) | Exit evidence |
|---|---|---|
| Feature | plan (T4) → build (T2, T3 in a hard domain) → verify (T2) → review (T3) → compound (T4) | verify ladder green, review findings closed |
| Bug fix | reproduce as a failing test (T2) → root cause (T4) → fix (T2) → verify (T2) → compound (T4) | the test failed before the fix and passes after |
| Refactor | map (T1) → plan (T4) → codemod or script (T0) → leftover edits (T2) → verify (T2) | same tests, same counts, smaller code |
| UI and design | critique against the stack's design checks (T3) → build (T2) → runtime screenshots or pixel diff (T2) → taste check (human) | screenshots in both appearances, no new token drift |
| API change | contract first (T4) → build (T2) → contract tests (T2) → security review (T3) | old clients still pass, new contract documented |
| Data or migration | plan and dry run (T4) → build (T2) → dry run against a copy (T2) → human gate → apply | dry-run output read by a person before apply |
| Research | fan out readers (T1 for local files, T2 for the web) → synthesize (T4) | every claim has a source the reader can open |
| Audit | parallel reviewers (T3) → verify each finding (T2) → rank (T4) | each finding has a file:line and a failing scenario |
| Release and ops | scripted steps (T0) → log triage (T1) → decisions (T4) | the release checklist, each item with its command |
| Learning | `compound` after each solved problem (T4); `retro` weekly or after a hard session (T4) | the lesson landed as a test, a lint, a standard or a learning, in that order of preference |

## Escalation

Move a stage up one tier, or back to the leader, when any of these happens:

- The verify ladder is red twice on the same rung.
- The diff touches a protected path: auth, payments, migrations, secrets, anything the project marks as safety.
- The diff crosses a module or package boundary the plan did not name.
- The worker asks a question, reports ambiguity, or edits files outside its brief.
- Three fix rounds pass with no green. Stop and hand the evidence to a person.

## Moving work down

A task type moves down a tier only with evidence: `retro` shows the cheaper tier passing the same verify ladder across several sessions, or a benchmark run says so. Model pass rates overlap more than their prices do, so measure before paying for the bigger model, and measure again after moving down.
