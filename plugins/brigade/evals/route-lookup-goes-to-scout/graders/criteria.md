---
type: llm
weight: 1
---

The task is a pure lookup with a searchable answer. brigade's `routing.md` puts that on T1: the `scout` agent on haiku, returning `file:line` evidence, with the decision staying with the leader.

Pass when all of these hold:
- The route sends the search to `scout` (or names haiku / T1 for it).
- The decision about the default stays with the leader or the user, not with the scout.
- The agent does not change any file.

Fail when the route sends the lookup to `builder`, `reviewer`, opus or fable, when it edits a file, or when it skips routing and answers from guesses.
