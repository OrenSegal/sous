# Building a harness you can trust

A practical guide to what a coding-agent harness is, which parts you actually
need, what to install, and where the open problems are. It is written for
someone who uses Claude Code daily and wants fewer surprises, not more
tooling.

Two things up front. Everything marked **today** is in sous and has a test.
Everything marked **not built** is a proposal, and the section says why it is
worth building. Where a claim comes from community or web research rather than
from this repo, it is attributed, and it is a snapshot of early October 2026,
not a ruling.

## The harness is more than MCP

The model is rented. The harness is the part you own: everything around the
model that decides what it sees, what it may touch, and what stops it. MCP
servers are one layer of that. If you only audit them, you have audited the
smallest door.

| Layer | What it is | The failure you actually see |
|---|---|---|
| Memory | `CLAUDE.md`, `AGENTS.md`, skills | Rules that say "never X" with nothing enforcing them; a 600-line file the model skims |
| Tools | MCP servers, plugins, mods | A new server or plugin update changes what the agent can do, and nobody noticed |
| Permissions and sandbox | `settings.json` deny/ask, OS sandbox | `/bin/rm -rf` walks past `Bash(rm:*)`; the agent edits its own settings |
| Hooks | `PreToolUse` and friends | A hook that points at a deleted script and silently does nothing |
| Human gates | `ask` rules, bypass mode | Bypass mode skips every gate you thought you had |

sous covers all five (see the [README](../README.md)). The rest of this guide is
about choosing what goes into the tool layer and what is still missing around
it.

## What is actually necessary

Research from this window (Reddit, X, Hacker News, GitHub, and the web
roundups from Firecrawl, Composio and Scrimba) keeps converging on a short
list. Start here and add only when you can name the weekly task.

**Install:**

- **Language server plugins** for the languages you write (TypeScript, Python,
  Rust, Go). They give the agent real diagnostics and go-to-definition instead
  of guessing from text. Cheapest high-value install.
- **A docs server such as Context7.** Fixes the agent calling an API that
  changed two versions ago.
- **One browser tool**, either Playwright or chrome-devtools-mcp. Pick the one
  that matches how you verify UI. You do not need both.
- **GitHub**, if you review or triage through the agent. The `gh` CLI is a
  fine substitute and costs no schema tokens.
- **One data server** (Postgres or Supabase) only if the agent really queries
  it. Scope it read-only first.
- **A review plugin** such as pr-review-toolkit, and a commit helper if you
  want consistent messages.

**Be skeptical of:**

- Anything you installed once to try. Every connected server's tool schemas
  load into context. One community estimate from this run put schemas at
  roughly 72% of the window for people running many servers. Check your own
  number rather than trusting that one.
- Workflow frameworks that restructure the whole session. Superpowers reports
  over a million installs and many people like it, but it is a large change to
  how the agent behaves. Adopt it deliberately, not as a default.
- Plugins whose description you cannot summarize in one sentence.

A useful test for any addition: what is the single task I run weekly that this
makes better, and what does it cost in context and in trust?

## Mods: what to install and what to create

Mods are the newest extension surface. Claude Code's own `plugin-authoring`
skill defines one: a plugin whose `hooks/hooks.json` names a TypeScript module
(`{ "modules": ["./register.tsx"] }`) that exports
`register(on, options)`. It hot-reloads in the session once the person
approves it. A mod can:

- draw a pane, a band above the prompt, a status line entry or a toast
- hook `tool.call` to deny, rewrite or react to a tool call
- hook `prompt.submit` and `prompt.compose` to change what is sent
- register slash commands, run timers, and reach files and processes through
  `$.fs` and `$.process`

Check a mod with `claude plugin validate <folder>` and test it with
`claude plugin test <folder>`.

That list is the trust model. A mod that can deny or rewrite tool calls and
read your prompts is a hook with a UI, running in your session, so it deserves
the same review as a hook. It is also why a harness checker should treat mods
as first-class: a `tool.call` hook in a mod can do what `sous-guard.sh` does,
or quietly undo it. `sous accept` hashes a mod's files under `hooks/`, so an
edited module shows as drift, but sous does not read which events it hooks;
that is gap 3 below.

**Install policy for mods and plugins:**

1. Read the source before enabling. They are short.
2. Prefer ones that do one narrow thing and declare what they touch.
3. Pin to a version or sha. A floating ref means the next update is untested
   code in your session.
4. Record the set afterwards (`sous accept`) so a later change shows.

**Mods worth creating** (each is a gap the research points at, not an
existing product):

- **Context meter.** Shows what the loaded memory files, skills, MCP schemas
  and plugin hooks cost in tokens right now. Nothing in the evidence I found
  measures this per server, and it is the first thing people ask for once they
  hit the wall.
- **Change gate.** On session start, compares the tool set and its
  descriptions to a recorded baseline and stops if something moved without
  review.
- **Slop check for UI work.** The r/ClaudeAI thread on generic AI-looking
  interfaces drew 431 points. A mod that runs the design plugin's checklist
  against what the agent just produced, and shows the failures, is a
  different product from another generator.
- **Cross-harness doctor.** Reads the Claude Code, Codex and Cursor configs in
  one project and reports where they disagree (see below).

## An installed set, read as a harness

A reload in the session this guide was written in reported 10 plugins, 62
skills, 11 agents, 6 hooks, 2 plugin MCP servers and 1 LSP server. That is a
realistic power-user setup, and it shows where the cost hides: not in the two
MCP servers but in the 62 skills, whose names and descriptions are listed to
the model every session. Group what you have by the job it does, and ask of
each group whether you would notice it missing.

| Group | Examples in this set | What to ask |
|---|---|---|
| Checking the agent | sous (guard, doctor, `test-audit`), cited (sources that do not say what is claimed), scoped (concurrent sessions editing the same files) | These are the harness. Keep, and run their doctors in CI |
| Engineering method | mattpocock-skills (`tdd`, `diagnosing-bugs`, `code-review`, `to-spec`, `to-tickets`, `implement`, `handoff` and others), `commit`, `interview` | Many overlap. Pick one path for spec to tickets to implement and disable the rest |
| Research and content | last30days, makerskills (`deep-research`, `ingest`, `second-brain`, `slide-deck` and others), `podcast` | Useful on demand, costly always-on. Good candidates to enable per project |
| Design | impeccable, `app-icon-generator`, dataviz | Keep for UI work, off elsewhere |
| Built-in and Anthropic | `code-review`, `simplify`, `loop`, `schedule`, `update-config`, `fewer-permission-prompts`, `plugin-authoring`, the `anthropic-skills:*` document and browser skills | Mostly free. `fewer-permission-prompts` and `update-config` are harness tools in their own right |
| Project glue | `orca-cli`, `orca-linear`, the Linear MCP server | Keep only in the projects that use them |

Two practical moves follow from the table. First, `code-review` exists both as
a built-in and inside mattpocock-skills, and `code-review` and `simplify` cover
adjacent ground; decide which you trust and let the others go. Second, the
per-skill description cost is exactly what the context meter (below) should
report, because today you can only see it by running out of room.

### Two mods worth installing

- **Blast Radius** ([cskwork/claude-code-mods](https://github.com/cskwork/claude-code-mods),
  `claude plugin install blast-radius@claude-code-mods`). Before a risky Bash
  command (recursive delete, `git reset --hard`, force push, `kubectl delete`,
  SQL wipes) it dry-runs what would be touched and asks Proceed or Cancel. It
  complements `sous-guard`: the guard refuses outright, this one lets you look
  and decide. It is third-party; read the source and pin it as the install
  policy above says.
- **handoff** (`mods/handoff` here, `claude plugin install handoff@sous`). After
  each turn that changes the tree it writes `.claude/handoff/LATEST.md` and
  `LATEST.patch` (secret-looking files excluded, folder self-ignored), so the
  next session can start from "read `.claude/handoff/LATEST.md`".

## What sous does today for these layers

Checked against the repo, not from memory:

- **Tool-set drift.** `sous accept` (or a first `sous probe --record`)
  fingerprints `.mcp.json` servers (names and shape, never env or header
  values) and each enabled plugin's surface: hook commands, files under
  `hooks/` and `bin/`, and the `allowed-tools` it asks for. `sous doctor` notes drift; `--strict` fails on it.
- **Hidden instructions.** `sous lint` and `sous doctor` scan memory files,
  skills, commands, agents and `.mcp.json` for invisible characters and for
  lines that tell the agent to drop its instructions, hide something from the
  user or exfiltrate a secret. It is a short pattern list, so a clean scan is
  not proof.
- **Unenforced prohibitions.** `sous lint` finds "never X" lines that no deny
  rule or guard rule backs; `--fix` adds the missing deny rules.
- **Self-tampering.** `install` deny-lists edits to `.claude/settings.json`,
  `.claude/hooks/**` and `.mcp.json`.
- **Other agents.** `sous compile --to=agents|cursor|copilot` writes the deny
  rules as plain instructions. Those agents read it as a request; only Claude
  Code enforces it.

## Gaps worth building (not built)

Ordered by how strong the evidence is. Each says what sous would do and what
it would not claim.

### 1. Per-server context cost

**Problem.** Nobody ships a number. People discover the cost when the window
fills.
**Shape.** `sous doctor` estimates tokens for each memory file, skill, `.mcp.json`
server and plugin, and warns over a configurable budget, the way it already
warns on `SOUS_MEMORY_LINES`.
**Honest limit.** Schemas for remote servers are only known after connecting.
Offline, sous can count what is on disk and must label the rest as unknown, not
guess.

### 2. An allowlist with pinned fingerprints

**Problem.** Drift detection says "something changed". It does not say whether
that thing was ever approved. The advice that keeps recurring (CSA, Cycode,
howtoharden) is to audit against an explicit allowlist and treat a changed MCP
config as a code-review event.
**Shape.** A checked-in file of approved servers and plugins, each with a
pinned fingerprint. `doctor` fails on anything absent or changed.
**Honest limit.** Fingerprinting `.mcp.json` catches a changed command or URL.
It cannot see a remote server changing a tool description after connect. That
needs a runtime check and is a separate, harder piece.

### 3. Fingerprint the behavior, not just the version

**Problem.** A plugin that adds a hook or a permission ask in a patch release
has the same name and can keep the same version.
**Shape.** Include each enabled plugin's hook commands and the permissions it
requests in the fingerprint, so a new hook shows as drift. Partly built:
`sous accept` records these; the part below on mod events is not.

Mods raise the stakes here. Fingerprinting should read each enabled mod's
`hooks/hooks.json` and note which events its module hooks (`tool.call`,
`prompt.submit`, `prompt.compose`), because those are the ones that can
override the guard.

### 4. Delegate poisoning detection

**Problem.** Detecting tool poisoning well is a research area. A small pattern
list will lose to it.
**Shape.** If [snyk agent-scan](https://github.com/snyk/agent-scan) is
installed, `doctor --strict` runs it and reports its findings. sous stays the
gate and does not reimplement the scanner. Skip silently when it is absent.

### 5. Cross-harness consistency

**Problem.** The r/mcp thread asking for a one-sentence install shows the
friction of configuring the same server for Claude Code, Codex and Cursor.
**Shape.** A read-only check that parses each tool's MCP config in the project
and lists servers present in one and missing or different in another. Pairs
with `sous compile`, which already carries the deny rules across.
**Honest limit.** Config locations and formats change between tool releases.
Verify each against current docs before relying on the parse.

### Thinner evidence

Agent evals that could actually fail (see
[litmus](https://github.com/OrenSegal/litmus)), a knowledge-base server, and
payments or browser discovery all showed up, with less volume. Worth watching,
not yet worth building around.

## A sensible first hour

1. Run `sous install --dry-run`, read the diff, then install.
2. Add the one line to `~/.claude/settings.json` that disables bypass mode.
3. Run `sous lint` and read which of your "never" lines are decoration.
4. Remove every MCP server and plugin you cannot name a weekly use for.
5. Run `sous probe`, paste the prompts into a fresh session, then
   `sous probe --record`.
6. Put `sous doctor --strict` in CI so drift fails a build instead of a
   surprise.

## Where this comes from

Web sources: [Firecrawl](https://www.firecrawl.dev/blog/best-claude-code-plugins),
[Composio](https://composio.dev/content/top-claude-code-plugins),
[Scrimba](https://scrimba.com/articles/best-claude-code-plugins-2026/),
[Cycode on the OWASP MCP Top 10](https://cycode.com/blog/owasp-mcp-top-10/),
the [CSA note on tool poisoning](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-auto-execution-20260701/),
and [howtoharden](https://howtoharden.com/guides/claude-code/). Community
signal came from r/ClaudeAI, r/mcp and X over the 30 days to 2026-10-02. That
evidence was thin and partly off-topic, so the gaps above are directional, and
the repo claims are the part to rely on.
