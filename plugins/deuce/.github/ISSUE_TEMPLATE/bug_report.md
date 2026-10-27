---
name: Bug report
about: A branch swept that should not have been, one kept that should have gone, a crash, or a flag that does not do what the docs say
labels: bug
---

<!-- If deuce deleted work it should have refused (a dirty worktree, unpushed
commits, a remote branch with new commits), that is a security problem: use
the private advisory form, not this template. See SECURITY.md. -->

**What happened**

**What you expected**

**To reproduce**

The git commands that build the situation (a fresh repo, a bare remote, the branches and the merge), and the deuce command you ran:

```sh
git init ...
deuce sweep --json
```

Output, with `--json`:

```text
```

**Environment**

- deuce version (`deuce --version`):
- git version (`git --version`):
- gh version, if installed (`gh --version`):
- Python version (`python3 --version`):
- OS:
- Run through: Claude Code plugin / `bin/deuce` / `python3 -m deuce`
