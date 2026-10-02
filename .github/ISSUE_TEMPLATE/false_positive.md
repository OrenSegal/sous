---
name: False positive
about: The guard blocked a command that is safe
labels: false-positive
---

**The command** (exactly as Claude ran it; replace anything private)

```bash
```

**The block message**

```text
BLOCKED (sous): ...
```

**Why it is safe**

**`sous report` excerpt** (optional: how often this reason fires)

A fix lands as a `check 0` row in `tests/adversarial.test.sh` first. If you
open a PR, include that row.
