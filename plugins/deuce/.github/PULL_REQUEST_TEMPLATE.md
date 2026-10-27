## Problem

<!-- What was wrong or missing. Link the issue if there is one. -->

## Change

## Checklist

- [ ] `python -m pytest tests` passes
- [ ] `ruff check .` and `shellcheck bin/deuce` pass
- [ ] A test that fails without this change (for a fix or a new rule, an integration test against a throwaway repo)
- [ ] README, SECURITY.md or CHANGELOG.md updated if behavior, rules, flags, exit codes or the JSON schema changed
- [ ] No new runtime dependencies (deuce is standard library only)
