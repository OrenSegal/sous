**What changes and why**

**Red first**
- [ ] The new or changed test failed before this change (paste the failing line)
- [ ] All four suites pass: `sous-guard`, `adversarial`, `tests-ran`, `install`
- [ ] Guard changes pass under `/bin/bash` 3.2 too (macOS)
- [ ] `shellcheck -S warning` and `ruff check bin/sous` are clean
- [ ] CHANGELOG.md has a line under the next version
- [ ] If a guard message changed, `docs/demo.txt` and the README block are regenerated
