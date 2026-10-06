# Blast Shield

**See what a command will change before it runs.** Blast Shield is a Claude Code mod that holds risky shell commands, shows what they would touch and whether you can undo it, and runs them only when you press Proceed.

> Blast Shield is a modified fork of [Blast Radius](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius), the mod Anthropic's DevRel team shared in claude-code-playground. The original idea, the hold-and-ask design and the first set of dry runs are theirs. Blast Shield widens the coverage and the explanations. See [NOTICE](NOTICE) for exactly what changed. Not an official Anthropic product, and not endorsed by Anthropic.

## How it works

When Claude calls Bash with a risky command, the mod holds the call, measures what it would change, and opens a pane with **Proceed** and **Cancel**. Cancel refuses the command, and Claude is told why. Every other command runs as normal.

## What it holds

| Command | What the pane shows |
|---|---|
| `rm -r/-f`, `find ... -delete` | The files it would delete, with count and size. `find` is measured by running the same find with `-print`. |
| `xargs rm` | A note that the file list comes from stdin and can't be shown. |
| `git reset --hard` | Files with uncommitted changes, and `git diff --shortstat`. |
| `git checkout -- <path>`, `git restore <path>`, `git checkout .` | Changed files, limited to the paths named. |
| `git clean` | The untracked paths, from `git clean -n`. |
| `git push --force`, `-f`, `-uf`, `--force-with-lease`, `+ref` | Commits on the remote branch your push would drop. |
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

- It reads command text. `$(...)`, aliases, `eval`, `bash -c "..."`, scripts that call risky commands, and SQL piped to a client are not seen.
- Only the first risky part of a command line is measured. Proceed runs the whole line.
- Every recursive `chmod`/`chown` is held, however small.
- `terraform plan -destroy` refreshes state and can call your cloud provider, up to 60 seconds, before the pane appears.
- One hold at a time. In a narrow terminal the report uses the band above the prompt, which only one mod can draw.
- Hot-reloading the mod during a hold loses that hold's pane until it times out.
- A safety net, not a permission system. Use permission rules for a hard block.

## Run it

Requires Claude Code 2.1.287 or later, plus `bash`, `git`, `find` and `du`. `kubectl`, `terraform` and the others are used only when you run those commands.

It ships in the [sous](https://github.com/OrenSegal/sous) marketplace:

```bash
claude plugin marketplace add OrenSegal/sous
claude plugin install blast-shield@sous --scope user
```

Or load it from a clone:

```bash
git clone https://github.com/OrenSegal/sous.git
claude plugin validate ./sous/mods/blast-shield
claude --plugin-dir ./sous/mods/blast-shield
```

Try it in a throwaway folder: ask Claude to delete a build folder.

## Tests

```bash
claude plugin test .     # classifier tests
node test/verify.mjs     # measures against a real temp git repo, with real processes
```

The pane and the live hold have no automated test yet. They were not exercised end to end before release.

## License

Apache-2.0. Copyright 2026 Anthropic PBC for the original Blast Radius, and 2026 Oren Segal for the modifications. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
