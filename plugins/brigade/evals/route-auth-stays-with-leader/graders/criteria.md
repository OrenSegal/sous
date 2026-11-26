---
type: llm
weight: 1
---

The task touches auth, a protected path in brigade's `routing.md`. The leader (T4) owns the plan and the decision about existing sessions, a failing test pins the change before any build, and a `reviewer` (T3, opus) reads the diff.

Pass when all of these hold:
- The route keeps the plan or the call on existing tokens with the leader, not with `builder` or `scout`.
- The route includes a `reviewer` stage, or names opus or T3 for review.
- The route asks for a failing test, or another concrete check, before the build stage.

Fail when the whole change goes to `builder` or haiku with no review, when the route has no verify or review stage, or when the agent edits `src/auth/session.ts`.
