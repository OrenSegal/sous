# Contributing

This is a small, single-file shell script with a fixture-backed test suite.
Contributions that keep it that way are welcome.

## Setup

Nothing to install. The script only needs `bash`, `grep`, and `xargs` — all
present on any standard Linux/macOS box. Clone the repo and you're ready:

```bash
git clone https://github.com/OrenSegal/architecture-lint.git
cd architecture-lint
```

## Running the tests

```bash
./tests/run.sh
```

Each test runs the real `architecture-lint.sh` binary against a fixture
under `tests/fixtures/` and asserts an exit code — there's no mocking. If
you're adding a fixture, follow the existing naming (`tests/fixtures/<case>/
src/<Module>/File.ext`) and point `ARCH_LINT_MODULES_ROOT` /
`ARCH_LINT_FILE_GLOB` at it, the same way the existing cases in
`tests/run.sh` do.

CI also runs [ShellCheck](https://www.shellcheck.net/) against every `.sh`
file in the repo. Run it locally before opening a PR:

```bash
shellcheck architecture-lint.sh tests/run.sh
```

## What a PR should include

- **A fixture-backed test** for any new behavior or bug fix — see "Running
  the tests" above. A change nobody can regress-test isn't done.
- **A passing `./tests/run.sh`** and a clean `shellcheck` run.
- **A short explanation of why**, not just what — this script's whole
  premise is that config-driven checks rot if nobody can see the reasoning
  behind them six months later. The same applies to the script itself.
- Keep the diff scoped. This is meant to stay a single readable file you can
  drop into any repo and audit in five minutes; avoid adding dependencies,
  splitting it into multiple scripts, or introducing config formats beyond
  the `BOUNDARIES` array and the baseline JSON.

## Reporting a bug

Open an issue with the exact command you ran, the fixture or repo layout
that triggers it (or a minimal reproduction), and what you expected instead.
