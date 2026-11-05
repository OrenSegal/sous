# Blast Shield

[![test](https://github.com/OrenSegal/blast-shield/actions/workflows/test.yml/badge.svg)](https://github.com/OrenSegal/blast-shield/actions/workflows/test.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**See what a command will change before it runs.** Blast Shield is a Claude Code mod that holds risky shell commands, shows what they would touch and whether you can undo it, and runs them only when you press Proceed.

> Blast Shield is a modified fork of [Blast Radius](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius), the mod Anthropic's DevRel team shared in claude-code-playground. The original idea, the hold-and-ask design and the first set of dry runs are theirs. Blast Shield widens the coverage and the explanations. See [NOTICE](NOTICE) for exactly what changed. Not an official Anthropic product, and not endorsed by Anthropic.

Related: [sous](https://github.com/OrenSegal/sous) hard-blocks destructive commands; Blast Shield previews them and asks.

## Differences from Blast Radius

- More git commands held: `checkout`/`restore` with paths, `push -uf`, pushes that delete a remote branch, `branch -D`, `stash drop`/`clear`.
- More commands held: `find` with its delete action or `-exec rm`, `sh -c` scripts, python `shutil.rmtree`, `xargs rm`, `kubectl delete`, `terraform`/`tofu destroy`, Docker/Podman prune and volume removal, destructive SQL, recursive `chmod`/`chown`/`chgrp`.
- Sees through the `timeout`, `doas`, `env` and `time` wrappers.
- Dry runs for kubectl, terraform, find, branch deletes and stashes; `rm` globs no longer count dotfiles the shell would not expand.
- Pane adds Held, Undo and Impact lines and wraps the command; the refusal message names the matched rule and its consequences.
- Classifier tests and a real-process verification script.

## How it works

When Claude calls Bash with a risky command, the mod holds the call, measures what it would change, and opens a pane with **Proceed** and **Cancel**. Cancel refuses the command, and Claude is told why. Every other command runs as normal.

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

CI runs `node test/verify.mjs` on Ubuntu and macOS. The classifier tests need the `claude` CLI, so they run locally only.

The pane and the live hold have no automated test yet. They were not exercised end to end before release.

## License

Apache-2.0. Copyright 2026 Anthropic PBC for the original Blast Radius, and 2026 Oren Segal for the modifications. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
