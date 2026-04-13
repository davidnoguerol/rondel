# @rondel/web

Human-facing web UI for the Rondel daemon. Built with Next.js 15 (App Router),
React 19, Tailwind CSS, and Zod.

## What this is

A **client** of the Rondel daemon's internal HTTP bridge. It renders server
state — agents, ledger events, memory — directly in Server Components. Writes
go through Server Actions. The daemon is the single source of truth; the web
package never holds state of its own.

## What v1 is NOT

- Not a replacement for the CLI or Telegram — it's a *complementary* interface.
- **Not authenticated.** The middleware at `apps/web/middleware.ts` rejects any
  request whose `host` header is not `127.0.0.1` or `localhost`. Do NOT remove
  this gate before you replace it with a real session check. See
  `lib/auth/require-user.ts` for the one helper to swap.
- Not a live dashboard — there's no SSE/WebSocket in v1. The bridge has no
  streaming endpoint yet; once it does, the proxy and refresh button will
  learn about it together. Until then, the ledger page has a "Refresh" button.
- Not mobile-polished — desktop dashboard only.
- No dark-mode toggle, no i18n, no admin CRUD forms yet. Those come in M2+.

## Prerequisites

- **Rondel daemon running** — this package reads the bridge URL from
  `$RONDEL_HOME/state/rondel.lock`. Start the daemon with `rondel start`
  (or install the OS service via `rondel service install`).
- **pnpm 10+** and **Node 22+**.

## Run it

From the repo root:

```bash
pnpm install              # first time, or after dep changes
pnpm web:dev              # starts Next on http://127.0.0.1:4242
```

Or from this directory:

```bash
pnpm dev
```

Open `http://127.0.0.1:4242` — you'll land on the agent list.

## Architecture in one page

```
browser  →  Next.js (Server Components)  →  lib/bridge/client.ts  →  bridge
                                             │                         (daemon
                                             │                          HTTP,
                                             │                          localhost
                                             ▼                          random
                                        discovery.ts                    port)
                                             │
                                             ▼
                                 ~/.rondel/state/rondel.lock
```

- `lib/bridge/client.ts` — one typed method per endpoint. Every call is
  memoized per-request via React `cache()`, runs through a Zod response
  schema, and throws typed errors the boundary renders.
- `lib/bridge/discovery.ts` — reads the lock file, verifies the PID is
  alive, caches the URL for 5s, invalidates on `ECONNREFUSED` so a daemon
  restart is recovered in one retry.
- `lib/bridge/fetcher.ts` — one keepalive agent, 10s timeout, error
  classification, one automatic retry on connection refused.
- `lib/types/rondel.ts` — the ONE file that mirrors daemon types. Nothing
  else under `apps/web/` imports daemon code. See comments in that file.
- `app/api/bridge/[...path]/route.ts` — GET-allowlist proxy for Client
  Components that need to refetch. Admin and env paths are blocked. All
  non-GET methods return 405. Origin + host enforced on every request.

## Adding a screen

1. Add a method to `lib/bridge/client.ts`.
2. Add a Zod schema to `lib/bridge/schemas.ts`.
3. Add a page under `app/(dashboard)/...`. Fetch in the async body.
4. If the page needs client-side refetch, add the endpoint to the
   `GET_ALLOWLIST` in `app/api/bridge/[...path]/route.ts`.
5. If the page writes data, add a colocated `actions.ts` with
   `"use server"` and call `revalidateTag()` at the right tag.

## Error handling — read this before touching `error.tsx`

React Server Components serialize errors across the RSC boundary. **Only
`message`, `digest`, and `name` survive.** Custom properties like
`transient` or `status` do NOT reach the client error boundary.

This means: `error.tsx` must branch on `error.name` (a stable string tag),
never `instanceof` or custom props. Every error class in
`lib/bridge/errors.ts` sets `name` to a unique string. If you add a new
error class, do the same.

## Testing

One fixture-based schema test lives in `lib/bridge/__tests__/`. It parses
real captured bridge responses (`lib/bridge/__fixtures__/*.json`) through
the Zod schemas to lock in the shape contract. Run with:

```bash
pnpm test
```

When a daemon response shape intentionally changes, update the fixture:

```bash
BRIDGE_URL=$(python3 -c 'import json; print(json.load(open("$HOME/.rondel/state/rondel.lock"))["bridgeUrl"])')
curl "$BRIDGE_URL/agents" > apps/web/lib/bridge/__fixtures__/agents.json
```

…and bump `BRIDGE_API_VERSION` in `apps/daemon/src/bridge/schemas.ts`.

## Security posture in v1

- Next dev server binds to `127.0.0.1` only (`next dev -H 127.0.0.1`).
- Middleware rejects non-loopback Host headers with 403.
- `/api/bridge/[...path]` proxy: GET-only allowlist, origin check,
  admin and env paths explicitly blocked.
- Server Actions only for writes — Next's built-in CSRF protection applies.
- No client-side state means no XSS exfiltration paths to sensitive data.

This is appropriate for a single-user local tool. It is NOT appropriate for
LAN or remote deployment — see `lib/auth/require-user.ts` for the migration
path when multi-user becomes a requirement.

## Package manager note

The root repo uses `pnpm` workspaces. There is ONE lockfile at the repo
root (`pnpm-lock.yaml`). Never run `npm install` in this directory — it
would create a second, incompatible lockfile and break hoisting.
