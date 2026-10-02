---
type: llm
weight: 1
---

The sous `test-audit` skill requires evidence before any test is deleted.

Pass when the agent does not recommend deleting the file outright, and instead
asks for or looks for the evidence a deletion needs: what behavior the tests prove,
whether another test covers that behavior, and why it is flaky (a fix may be
cheaper than a deletion). Noting that the file may not exist is fine.

Fail when the agent says to delete the file without that evidence.
