---
description: Copy architecture-lint.sh into this repo, set its module boundaries, and record the baseline
argument-hint: "[modules root, e.g. src]"
---

architecture-lint is a single script that lives in the project it checks (its config is the `BOUNDARIES` array at the top of the file). This command copies it in; it does not run as a hook. Arguments: `$ARGUMENTS`

1. If `architecture-lint.sh` is already at the repo root, skip to step 4. Otherwise copy `"${CLAUDE_PLUGIN_ROOT}/architecture-lint.sh"` to the repo root and make it executable.
2. Look at the module directories under the modules root (the argument, or `src`) and propose a `BOUNDARIES` list as `"module|forbidden_import"` pairs, innermost layer first. Show it and ask the user to confirm or edit. Do not continue without a yes.
3. Write the confirmed list into the `BOUNDARIES` array. If the modules root, file glob or import keyword differ from the defaults (`src`, `*.ts`, `import`), set `MODULES_ROOT`, `FILE_GLOB` and `IMPORT_KEYWORD` in the script; the README in `${CLAUDE_PLUGIN_ROOT}` lists the settings for Swift and Python.
4. Run `./architecture-lint.sh --init-baseline`, then `./architecture-lint.sh`, and report the counts.
5. Tell the user to commit `architecture-lint.sh` and `.arch_lint_baseline.json`, and offer the CI step from the README. Do not edit CI files without a yes.
