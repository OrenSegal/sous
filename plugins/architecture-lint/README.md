# architecture-lint

[![CI](https://github.com/OrenSegal/architecture-lint/actions/workflows/ci.yml/badge.svg)](https://github.com/OrenSegal/architecture-lint/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-black)](LICENSE)

A config-driven module-boundary linter with a ratchet baseline, extracted from
patterns I use to keep a large Swift codebase (an iOS app in TestFlight beta)
honest about its own architecture docs.

## The problem

Architecture diagrams and "layer X must not import layer Y" rules rot the
moment nobody's forced to check them. Six months in, the diagram says one
thing and the imports say another, and nobody notices until a refactor gets
tangled in a dependency cycle that was never supposed to exist.

## The approach

Two ideas, both boringly simple and both worth stealing independent of each
other:

1. **Config-driven boundary rules.** Your module graph (`Domain → Data/Services
   → UI → App`, or whatever shape fits your codebase) is a list of
   `module|forbidden_import` pairs in the `BOUNDARIES` array at the top of
   the script, not hardcoded logic. There are no per-file annotations. Each
   module is a directory under `MODULES_ROOT`, and a violation is any line in
   that directory containing the import keyword followed somewhere by the
   forbidden module name as a whole word. It's a grep, not a parser, so it
   works for languages where an import fits on one line. See "Languages"
   below for what I've actually tested.

2. **Ratchet baseline, not a hard gate.** Introducing a lint rule into a
   codebase that already has debt usually means either a giant one-time
   cleanup PR, or nobody ever turns the rule on. Instead: record the current
   violation count as a baseline, and only fail CI when the count goes above
   that number. The baseline stores counts, not which lines were in
   violation, so fixing one old violation and adding a new one in the same
   change nets out to zero and passes. When the count drops, the script
   tells you to shrink the baseline, but it doesn't rewrite the file for
   you, and nothing stops someone from re-running `--init-baseline` to raise
   it. Keeping it from growing is up to code review.

There's also a second rule, `no_singletons`, ratcheted the same way. Its
pattern is hardcoded to Swift (`static let shared` / `static var shared`);
for another language you'd edit the regex in the script.

An inline `// arch-exempt: singleton` comment excludes that line from the
singleton count, for the legitimate exceptions (a framework that requires a
singleton, for example) without hiding them in a config file nobody reads six
months later. Boundary violations have no inline exemption. For those, the
baseline is the only way to let an existing one through.

## Usage

```bash
./architecture-lint.sh --init-baseline   # snapshot current violations
./architecture-lint.sh                   # check, fail only on regressions
```

Edit the `BOUNDARIES` array and the `MODULES_ROOT` / `FILE_GLOB` /
`IMPORT_KEYWORD` variables at the top of the script for your codebase's
language and module layout. Those three variables (not the `BOUNDARIES`
array) can be overridden with `ARCH_LINT_MODULES_ROOT`,
`ARCH_LINT_FILE_GLOB` and `ARCH_LINT_IMPORT_KEYWORD`, and the baseline path
with `ARCH_LINT_BASELINE_FILE`. `tests/run.sh` uses these to run the same
script against TypeScript and Swift fixtures without editing the file.

`MODULES_ROOT` is resolved from the directory you run the script in, so run
it from the repo root. If that directory doesn't exist, the script exits 1
instead of reporting a clean run with zero checks.

## Languages

Tested, with fixtures in `tests/`:

- **TypeScript** (`*.ts`, the default): `import { x } from '../UI/Screen'`
  is caught because `UI` appears as a word in the path.
- **Swift** (`*.swift`): `import UI` is caught, and `import CoreData` is not
  mistaken for the `Data` module.

Not covered by the test suite. I tried these by hand, and they're the
cases I'd expect to hit:

- **Python** needs `IMPORT_KEYWORD='(from|import)'`. With the default,
  `from UI.screen import x` is missed because the module name comes before
  the word `import`.
- **Go** only works for single-line imports (`import "example.com/app/UI"`).
  Imports inside a grouped `import ( ... )` block are on lines without the
  keyword, so they're missed.

Since matching is line-based text search, any line with the keyword and the
module name as a word counts, including comments or an imported symbol that
happens to share a module's name.

## Real output

Run against `tests/fixtures/violation`, where `Domain/User.ts` imports from
`UI/`, a boundary the config forbids, with an empty (all-zero) baseline:

```
Architecture Lint
==================

x Domain must not import UI:
   tests/fixtures/violation/src/Domain/User.ts:1:import { renderScreen } from '../UI/Screen';

Boundary checks run: 5

Ratchet: boundaries (baseline=0, current=1)
  REGRESSION: 1 new violation(s)

Ratchet: no_singletons (baseline=0, current=0)
  OK: at or within baseline

x Architecture lint failed: 1 violation(s)
  Fix them, or add an inline exemption with justification.
```

Exit code `1`. If the baseline is instead taken from this fixture
(`boundaries: 1`) and the script is run against `tests/fixtures/clean`, the
count is now below baseline, which is reported as "Improved" and exits `0`.

The last line suggests an inline exemption, but as noted above that only
works for singletons.

Both rules, the boundary check and `no_singletons`, are ratcheted the same
way: the baseline records a violation count per rule, and the gate fails
only when a count goes above it. So turning this on in a codebase that
already has boundary violations doesn't require fixing them all first. Run
`--init-baseline` once, and from then on CI fails only if the number of
violations grows.

## Using it in your own CI

There's no package to install. It needs `bash`, `grep` with `-E` and `\b`
support (GNU and BSD grep both work), and `xargs`, so it should run on any
Linux or macOS CI runner. I've only run it on GitHub Actions (`ubuntu-latest`)
and locally on macOS. Copy `architecture-lint.sh` into your repo
(alongside a `.arch_lint_baseline.json` from `--init-baseline`), edit the
`BOUNDARIES` array for your module graph, commit both, and gate CI on it:

```yaml
# .github/workflows/architecture-lint.yml
name: Architecture Lint

on:
  push:
    branches: [main]
  pull_request:

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run architecture-lint
        run: ./architecture-lint.sh
```

That's the whole setup. The script and baseline file live in your repo like
any other config, so there's nothing external for CI to fetch or pin a
version of. If you're evaluating whether to adopt it, curl the script to try
it against a checkout without committing it yet:

```bash
curl -fsSL https://raw.githubusercontent.com/OrenSegal/architecture-lint/main/architecture-lint.sh -o architecture-lint.sh
chmod +x architecture-lint.sh
./architecture-lint.sh --init-baseline
```

## Tests

```bash
./tests/run.sh
```

Thirteen fixture-backed cases, each running the real script and asserting
its exit code (one also checks for a warning message). No mocking:

- a clean module graph passes
- a boundary violation (`Domain` importing `UI`) fails against a zero baseline
- a singleton at baseline passes
- a new singleton beyond the baseline is caught as a regression
- an `// arch-exempt: singleton` comment excludes that line from the count
- a boundary violation count at baseline passes
- a new boundary violation beyond the baseline is caught as a regression
- fewer current violations than baseline reports "Improved" and still passes
- a missing baseline file exits 1 with a message
- an anchored import match (`import CoreData`) doesn't false-positive against
  a `Data` boundary rule
- a baseline file predating the `boundaries` key defaults it to 0 and warns,
  instead of crashing
- a modules root that doesn't exist exits 1, both on a normal run and on
  `--init-baseline`

CI runs this suite, plus ShellCheck against the shell scripts, on every push
to `main` and on pull requests (see the badge above).

## Limitations

The details are in the sections above; in one place:

- **The baseline counts, it doesn't remember.** Fixing one old violation and adding a new one in the same change nets to zero and passes. Anyone can re-run `--init-baseline` to raise the number. Code review has to catch both.
- **It's a grep, not a parser.** A comment, a string, or a symbol that shares a module's name counts as a violation. Multi-line imports (Go's grouped `import ( ... )`) are missed.
- **Only TypeScript and Swift are tested.** Python needs a different `IMPORT_KEYWORD`; Go works for single-line imports only.
- **`no_singletons` is Swift-only** unless you edit its regex.
- **Boundary violations have no inline exemption.** The baseline is the only way to let one through.

## Why I built this

I'm building a large iOS app (Swift 6, strict concurrency, seven Swift
packages, currently in TestFlight beta), and most of its code is written by
coding agents. Agents are good at making a change work and bad at noticing
they just imported the data layer into a view. There's no team to catch that
in review, so a CI check has to. This is a generalized, cleaned-up version of
the layering check that runs in that app's CI. One of the app's rules stops client code from calling LLM providers directly, so every model call goes through its gateway (the gateway's caching, circuit-breaker and budget patterns are in [llm-gateway-kit](https://github.com/OrenSegal/llm-gateway-kit)).
