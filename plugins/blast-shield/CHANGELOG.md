# Changelog

## 1.3.0

- Payments are held: MCP tools whose name has a payment word (charge, payment, pay, transfer, refund, invoice, checkout, payout, editable in the options), and `stripe` CLI commands that create, pay, confirm, capture, finalize or post one. Tools that start with a read verb (`list_invoices`, `get_payment`) are not.
- Optional daily allowance, off by default. A payment with a readable amount, in the allowance's currency, that fits in what is left today runs without a pane. It is reserved in the receipts before it runs and committed or released after. Everything else is held.
- Optional payee allowlist, and a flag on the first payment to a payee in a project.
- Receipts: one JSON line per decision in `~/.claude/blast-shield/spend/<project>.jsonl`.
- Reservations are serialized across sessions in a project through a lock folder, not only within one session.
- A payment refused before the tool ran (a permission rule, the prompt) is released; a tool that ran and errored is committed. Told apart by the host's PostToolUse and PostToolUseFailure events.
- A bare `amount` is read as cents only for servers listed in "Spend: servers that send cents"; everything else is major units.
- The allowance day is the UTC day.
- Write and Edit calls, and Bash commands that write, into `~/.claude/blast-shield/` are refused.
- The hold loop is shared between commands and payments, so a payment waits its turn behind a held command.


## 1.2.2

- Pane copy no longer says things twice: the title is fixed, "Held" no longer repeats the command, and the unrecoverable warning shows once.
- Changed-file rows use words (`deleted`, `modified`) instead of git status codes.
- The Bash hook now refuses the command if it errors, instead of letting it run.
- Test that the report draws with Proceed and Cancel on every surface.


- Status line scoreboard is shorter: `1 held · 0 refused · 1 ran`, without the redundant `shield:` prefix.
## 1.2.0

- `find` with its delete action reports `$VAR`, `$(...)`, backticks, `~` and start-path globs as unresolved instead of "delete nothing", since no shell expands them in the dry run. A find that fails with no matches says it could not measure.
- New holds: `sh -c` and similar shells (the script is classified as its own line), `find -exec rm` (measured with `-print`) and `find -exec` with another risky command, `python -c` with `shutil.rmtree`, and `git push` that deletes a remote branch (`:branch`, `--delete`, `-d`).

## 1.1.1

- `rm` and recursive `chmod`/`chown` targets that use `$VAR`, `$(...)` or backticks are reported as unresolved instead of "delete nothing".
- `git checkout`/`restore` paths go to git as pathspecs, so paths from a subfolder, `./` prefixes and globs are matched; the diff stat covers only those paths.
- `find` with its delete action is no longer dry-run when it also has `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint`, `-fprint0`, `-fprintf` or `-fls`, since the dry run would perform them.

## 1.1.0

- New **Impact** section in the pane: what else the command touches beyond the files, from read-only probes.
  - Deletes: how many files git can restore versus not, files outside a repo, regenerable build output, and path warnings (environment files, `.git`, local databases, SSH keys, migrations, CI workflows, lockfiles, served assets).
  - Force-push: CI workflows that will re-run, open pull requests on the branch (needs `gh`), shared branch names.
  - Migrations: destructive-looking migration names, and that they run on the database your environment points to.
  - kubectl: current cluster context, namespace, storage and workload effects. Terraform: workspace and data-store resources. Docker: usage, unused volumes, containers using a volume.
  - SQL: CASCADE and downstream readers. `prod`/`production` in the command line. Broad or world-writable `chmod`/`chown`.
- Claude's refusal message now includes the consequences, so it can explain them.

## 1.0.0

First release of Blast Shield, forked from Blast Radius (see NOTICE).

- Holds `git checkout`/`restore` with paths, `git push -uf`, `git branch -D`, `git stash drop/clear`, `find` with its delete action, `xargs rm`.
- Holds `kubectl delete`, `terraform`/`tofu destroy`, `docker`/`podman` prune and volume removal, destructive SQL, recursive `chmod`/`chown`/`chgrp`.
- Sees through `timeout`, `doas`, `env` and `time` wrappers.
- Pane shows why the command was held and whether it can be undone.
- Stops counting dotfiles in `rm` globs that the shell would not expand.
- Adds classifier tests and a real-process verification script.
