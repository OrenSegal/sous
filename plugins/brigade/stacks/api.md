# Stack: API and backend services (HTTP, edge functions, workers)

## Verify ladder

| Rung | Typical command | Proves |
|---|---|---|
| fast | the type checker and linter (`tsc --noEmit`, `deno check`, `ruff check`, `go vet`) | types and lint |
| verify | unit tests, then contract tests against the schema (OpenAPI, JSON Schema or typed client) | handlers behave and the contract holds |
| runtime | run the service locally, call each touched endpoint with a real request, read status, body and logs | the deployed shape works, not only the function |

## Done means

- Every touched endpoint called once with a valid request and once with an invalid one, with the responses shown.
- Old clients still work: the contract change is additive, or versioned, or every caller was updated in the same change.
- Errors return a stable shape and status code. No stack traces or internal names in responses.
- Timeouts, retries and idempotency stated for anything that calls out or writes.
- Logs carry a request id and no secrets or personal data.

## Review for

- Authentication and authorization on every route, including the new one.
- Input validation at the boundary. Size limits on bodies and uploads.
- N+1 queries, unbounded lists without pagination, missing indexes for new filters.
- Secrets read from config, never from code. Keys scoped to what the service needs.
- Rate limits and cost limits on anything that calls a paid model or service.

## Product and design checks

- An API is a product for its callers. Names, error messages and defaults should make the common call obvious.
- Document each new endpoint or field where callers already look (the schema, the typed client, the README).

## Traps

- A function deployed by hand drifts from the repo. Compare the deployed version with the branch before debugging it.
- Local emulators skip auth, quotas and network limits. Treat a local pass as necessary, not sufficient.
