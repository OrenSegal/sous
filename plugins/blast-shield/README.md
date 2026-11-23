# Blast Shield

[![test](https://github.com/OrenSegal/blast-shield/actions/workflows/test.yml/badge.svg)](https://github.com/OrenSegal/blast-shield/actions/workflows/test.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**Decide before an agent runs a command that's hard to take back.** Blast Shield is a Claude Code mod that holds risky shell commands, shows what they would touch and whether you can undo it, and runs them only when you press Proceed.

It does not undo anything itself. It moves the decision to before the command runs, while it can still be made.

> Blast Shield is a modified fork of [Blast Radius](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius), the mod Anthropic's DevRel team shared in claude-code-playground. The original idea, the hold-and-ask design and the first set of dry runs are theirs. Blast Shield widens the coverage and the explanations. See [NOTICE](NOTICE) for exactly what changed. Not an official Anthropic product, and not endorsed by Anthropic.

Related: [sous](https://github.com/OrenSegal/sous) hard-blocks destructive commands; Blast Shield previews them and asks.

## Differences from Blast Radius

- More git commands held: `checkout`/`restore` with paths, `push -uf`, pushes that delete a remote branch, `branch -D`, `stash drop`/`clear`.
- More commands held: `find` with its delete action or `-exec rm`, `sh -c` scripts, python `shutil.rmtree`, `xargs rm`, `kubectl delete`, `terraform`/`tofu destroy`, Docker/Podman prune and volume removal, destructive SQL, recursive `chmod`/`chown`/`chgrp`.
- Sees through the `timeout`, `doas`, `env` and `time` wrappers.
- Dry runs for kubectl, terraform, find, branch deletes and stashes; `rm` globs no longer count dotfiles the shell would not expand.
- Pane adds Held, Undo and Impact lines and wraps the command; the refusal message names the matched rule and its consequences.
- Holds payments too: MCP tools named like payments and Stripe CLI payment commands, with an optional daily allowance and receipts.
- Classifier tests and a real-process verification script.

## How it works

When Claude calls Bash with a risky command, the mod holds the call, measures what it would change, and opens a pane with **Proceed** and **Cancel**. Cancel refuses the command, and Claude is told why. Every other command runs as normal.

Payments get the same hold. See [Payments](#payments).

## What it holds

| Command | What the pane shows |
|---|---|
| `rm -r/-f`, `find ... -delete`, `find ... -exec rm` | The files it would delete, with count and size. `find` is measured by running the same find with `-print`. When its paths or tests use `$VAR`, `~` or a glob the shell would expand, the pane says it can't resolve them. |
| `sh`, `bash`, `zsh`, `dash`, `ksh` with `-c '<script>'` | The script is read as a command line of its own, and the pane shows what its first risky part would change. |
| `find ... -exec` with another risky command | A note that it runs once per match and can't be measured. |
| `python -c` with `shutil.rmtree` | The files it would delete when the path is a quoted literal, otherwise a note that it can't list them. |
| `xargs rm` | A note that the file list comes from stdin and can't be shown. |
| `git reset --hard` | Files with uncommitted changes, and `git diff --shortstat`. |
| `git checkout -- <path>`, `git restore <path>`, `git checkout .` | Changed files, limited to the paths named. |
| `git clean` | The untracked paths, from `git clean -n`. |
| `git push --force`, `-f`, `-uf`, `--force-with-lease`, `+ref` | Commits on the remote branch your push would drop. |
| `git push origin :branch`, `git push --delete`, `-d` | The remote branches, and commits on them that no local branch has. |
| `git branch -D` | Per branch, whether it has commits no remote branch has. |
| `git stash drop`, `git stash clear` | The stash entries. |
| `manage.py migrate`, `db:migrate`, `alembic upgrade`, `prisma migrate` | The pending migrations. Any other `migrate` gets a "can't list" note. |
| `kubectl delete` (and `oc`) | The resources, from `--dry-run=client`. |
| `terraform destroy`, `apply -destroy` (and `tofu`) | The resources to destroy, from `plan -destroy`. |
| `docker`/`podman` `system prune`, `volume rm/prune`, `image prune -a`, `compose down -v` | A note that it can't list what goes. |
| `psql`, `mysql`, `sqlite3` and similar with `DROP`, `TRUNCATE`, or `DELETE FROM` without `WHERE` | A note that it can't count what is affected. |
| `chmod`/`chown`/`chgrp -R` | The files it would touch, with count and size. |

`timeout N`, `doas`, `sudo`, `env`, `time`, `nice`, `nohup` in front are seen through. `cd`, `pushd`, `popd` and `git -C` earlier on the line change where it measures.

## Payments

An MCP tool whose name looks like a payment is held for **Proceed** or **Cancel**, the same way as a risky command. So is a `stripe` CLI command that creates, pays, confirms, captures, finalizes, sends or posts a charge, payment, transfer, refund, invoice, checkout or payout.

- **What counts.** A word in the tool's name, after `mcp__<server>__`, matches one of `charge`, `payment`, `pay`, `transfer`, `refund`, `invoice`, `checkout`, `payout`, or its plural. `mcp__stripe__create_charge` and `mcp__bank__send_transfer` are held. A name that starts with a read verb (`list`, `get`, `retrieve`, `search` and similar) is not, so `list_invoices` runs as normal. The list is the **Spend: tool name patterns** option.
- **Default.** Every payment is held.
- **Daily allowance (off by default).** Set **Spend: daily allowance** (for example `20`, meaning 20.00 in **Spend: allowance currency**). A payment that fits in what is left today runs without a pane and is still logged. Anything else is held: over the allowance, another currency or none, no amount found, a payee outside the allowlist, or a receipts file that can't be read. Stripe CLI commands are always held, because amounts aren't read from shell commands.
- **Reserve, then commit or release.** A payment the allowance lets through is written to the receipts as `allowed` before it runs, so a payment in flight already counts against the day. When the tool answers, a `commit` line follows. A `release` line returns the amount when the call never ran: another mod's hook denied it, or it was refused before the tool ran (a permission rule, the permission prompt, a headless session that can't ask). Blast Shield tells these apart by whether the host reported the tool as run. A tool error is committed, because the payment may have gone through. A payment you approve with Proceed is reserved the same way, as `approved`, and counts toward the day too. Checks and reservations run one at a time, within a session and across sessions in the same project (through a lock folder next to the receipts), so payments made at once can't both fit in the same room.
- **Amounts.** Read from `amount`, `amount_cents`, `amount_in_cents`, `cents` or `amount_minor`, at the top level of the input or one level down, with `currency` beside it. Fields named for cents are minor units. A bare `amount` is read in major units, unless the tool's server is listed in **Spend: servers that send cents** (for Stripe's API, which sends cents, add `stripe`). Reading major units by default over-counts a cents-based server rather than under-counting a dollar-based one. A zero, negative, non-numeric, or over-precise amount counts as no amount.
- **Payees.** Read from `payee`, `recipient`, `destination`, `to`, `customer`, `merchant`, `vendor` or `account`. **Spend: payee allowlist** (comma-separated) limits who the allowance may pay. A payee outside it is held. The first payment to a payee in a project is flagged: in the pane when held, and in a toast when the allowance lets it through. It is a warning, not a hold.

Set the options with `/config`, or under `pluginConfigs` in `~/.claude/settings.json`.

### Receipts

Each decision is appended as one JSON line to `~/.claude/blast-shield/spend/<project>.jsonl`, where `<project>` is the session folder with every run of non-alphanumeric characters turned into `-`. The file lives outside the project so it doesn't land in git. Each line has `ts`, `session`, `tool`, `amount` (minor units, or null), `currency`, `payee`, `decision` and `reason`. Reserved lines and the `commit` or `release` that settles them share an `id`. For a Stripe CLI command, `tool` names only the resource and verb, never the line, which can carry an API key. Other tool input is not stored.

`decision` is one of `allowed`, `approved`, `commit`, `release`, `cancel`, `timeout`, `interrupted`, `error`.

Read it with `jq`:

```bash
# every line, newest last
jq -c . ~/.claude/blast-shield/spend/*.jsonl
# today's reserved total per currency (UTC day), in major units (reserved minus released, as the allowance counts it)
jq -rs --arg d "$(date -u +%F)" '
  (map(select(.decision == "release") | .id)) as $rel
  | map(select((.decision == "allowed" or .decision == "approved")
      and (.id as $i | $rel | index([$i]) | not)
      and (.ts | sub("\\.[0-9]+Z$"; "Z") | fromdate | strftime("%F")) == $d))
  | group_by(.currency) | .[] | "\(.[0].currency) \(map(.amount) | add / 100)"
' ~/.claude/blast-shield/spend/*.jsonl
```

## Reading the pane

- **Command**: the full command, wrapped (cut at 300 characters).
- **Would**: what it will do, in numbers where they can be measured.
- **Held**: which rule matched, and which part of the line when there are several commands.
- **Undo**: whether you can take it back.
- **Impact**: what else it touches, such as CI, open pull requests, databases, clusters, secrets. Each line comes from something read (a file name, a probe's output), not a guess about your project. At most 5 lines.
- Below that: the first 10 items, then a note on where the numbers came from.
- Press `1` to run it as written, `2` to refuse it. Cancel has focus, so Enter refuses. No answer in 10 minutes refuses it.

When a dry run fails (no cluster, no credentials, not a repo), the pane says so and still holds the command.

## Limits

- It reads command text. `$(...)`, aliases, `eval`, `sh -c "$VAR"`, scripts that call risky commands, other Python file deletes, Python piped or run from a file, and SQL piped to a client are not seen.
- Only the first risky part of a command line is measured. Proceed runs the whole line.
- Every recursive `chmod`/`chown` is held, however small.
- `terraform plan -destroy` refreshes state and can call your cloud provider, up to 60 seconds, before the pane appears.
- One hold at a time. In a narrow terminal the report uses the band above the prompt, which only one mod can draw.
- Hot-reloading the mod during a hold loses that hold's pane until it times out.
- A safety net, not a permission system. Use permission rules for a hard block.
- Payments are matched by tool name. A payment tool named something else (`mcp__x__run`, `mcp__x__buy`) is not held; add its word to the patterns. A tool named like a payment that isn't one is held.
- Payments made another way are not seen: a `curl` to a payment API, an SDK call in a script, a browser.
- Blast Shield does not reverse payments. Proceed sends the call as written.
- It does not detect fraud. The payee allowlist and the first-payee flag compare names, nothing more.
- Amounts in currencies without cents (yen, for example) are read as if they had two decimals, so set the allowance in the same units the tool sends.
- Blast Shield refuses Write and Edit calls into `~/.claude/blast-shield/`, and Bash commands that name that folder alongside a write (`>`, `rm`, `mv`, `sed -i`, a script interpreter and similar). That reads command text, so a path built from variables gets past it. Add a permission deny rule for a hard block. The plugin options live in your settings file, which Blast Shield does not guard.
- The receipts file is read in full for every payment, and never rotated. Past 4 MiB the read is cut off, and every payment is held until you move the file.
- Telling "refused before running" from "ran and failed" relies on the host's PostToolUse and PostToolUseFailure events reaching the mod before the call returns. That held on Claude Code 2.1.328 in the live check below. If a host stops raising them, refusals would be committed (counted), which errs on the safe side.
- A server listed in **Spend: servers that send cents** is trusted for every tool it has. Quantities, line items and fees are not added in: only the one amount field is read.
- "Today" is the UTC calendar day, the same wherever the host runs. In the Americas it rolls over in the late afternoon or evening.
- A payment that needs a person waits up to 10 minutes for Proceed or Cancel. In a headless session (`claude -p`, an SDK host) nobody can answer, so it waits the full 10 minutes and is refused. Set an allowance and a payee allowlist for unattended runs.

## Run it

Requires Claude Code 2.1.287 or later, plus `bash`, `git`, `find` and `du`. `kubectl`, `terraform` and the others are used only when you run those commands.

```bash
git clone https://github.com/OrenSegal/blast-shield.git
claude plugin validate ./blast-shield
claude --plugin-dir ./blast-shield
```

Or install it from this repo as a marketplace:

```bash
claude plugin marketplace add OrenSegal/blast-shield
claude plugin install blast-shield@blast-shield --scope user
```

Where it shows: one report, drawn by whichever surface runs the session. The terminal CLI and the desktop app dock it as a pane; VS Code, mobile, or a terminal too narrow for a pane get the same report in the band above the prompt. The desktop app has no flag, so name the folder in `CLAUDE_CODE_PLUGIN_DIRS` (in the `env` block of `~/.claude/settings.json`), or install it with the marketplace commands above and run `/reload-plugins`.

Try it in a throwaway folder: ask Claude to delete a build folder.

## Tests

```bash
claude plugin test .     # classifier tests, and the pane on every surface
node test/verify.mjs     # measures against a real temp git repo, with real processes
```

The payment tests (matcher, amounts, allowance math, ten reservations at once in one session and four sessions at once, first payee, receipts, the receipts guard) are in `test/verify.mjs`. Two in `hooks/classify.test.tsx` check that a payment under the allowance opens no pane and one with no amount is held.

Live check (2026-11-20, Claude Code 2.1.328, `claude -p` with a stand-in MCP server that moves no money): a payment under the allowance ran and left `allowed` then `commit`; one the server answered with an error left `commit`; one refused in `dontAsk` mode left `release`; a payment over what was left was held; and a Bash `>>` into the receipts folder was refused. The pane's buttons were not pressed in that check: headless sessions can't.

CI runs `node test/verify.mjs` on Ubuntu and macOS. The classifier tests need the `claude` CLI, so they run locally only.

The pane and the live hold have no automated test yet. They were not exercised end to end before release.

## License

Apache-2.0. Copyright 2026 Anthropic PBC for the original Blast Radius, and 2026 Oren Segal for the modifications. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
