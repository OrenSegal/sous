# Eval results

One row per `claude plugin eval` run, newest first. "with" is the score with the
sous plugin loaded, "without" the runner's no-plugin baseline arm. A case where
"without" scores as well as "with" does not show what sous adds; fix the case.

Run from the repo root (real sessions, costs money):

    claude plugin eval . --scaffold --allow-tools Bash --runs 3 --json evals/results/last.json

| date | sous | model | case | with | without | note |
|---|---|---|---|---|---|---|
