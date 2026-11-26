# Stack: web app (Next.js, React, TypeScript)

## Verify ladder

| Rung | Typical command | Proves |
|---|---|---|
| fast | `npm run lint && npx tsc --noEmit` | types and lint |
| verify | `npm test` (Vitest or Jest) and `npm run build` | logic, and that it builds for production |
| runtime | start the dev server, open each touched route in a browser, screenshot at phone and desktop width, run an accessibility check (axe or Lighthouse), read the console | users see what the change intended |

Vitest and Jest stay green when every test is skipped. Read the executed count, not the exit code alone.

## Done means

- `tsc` and lint clean, production build passes.
- Each touched route screenshotted at 375 px and desktop width, in light and dark if the site has both.
- No console errors or failed network requests on those routes.
- Accessibility check run on each touched route, with no new serious violations.
- Server and client boundaries respected: no secrets in client bundles, no server-only imports in client components.

## Review for

- Data fetching: waterfalls, missing caching, fetching on the client what the server already has.
- Unescaped user input, unsafe HTML, open redirects, missing auth checks on server actions and API routes.
- Layout shift, unoptimized images, large client bundles from a new dependency.
- Hydration mismatches from dates, random values or browser-only APIs during render.

## Product and design checks

- Works at phone width first, with no horizontal scroll.
- Keyboard reachable, visible focus, labels on every input and icon button, text contrast at least 4.5:1.
- Loading, empty and error states for every async view.
- One clear primary action per page. Copy says what happens, not how the system works.
- For taste, use the project's design skill if it has one (for example `frontend-design` or `emil-design-eng`) and look at the screenshot yourself.

## Traps

- The dev server and the production build behave differently (caching, env vars, edge runtime). Prove the build, not only dev.
- Preview deploys need their own env vars. A green local run does not prove the preview works.
