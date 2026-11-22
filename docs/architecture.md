# Architecture

Hono owns HTTP routes, authentication and response policy. The app still
renders its production HTML with Hono JSX. Bun and Cloudflare use the same
application services and domain rules, with platform-specific adapters.

| Directory | Responsibility |
| --- | --- |
| `src/domain` | Namespace and queue rules, persistence contracts, typed errors |
| `src/application` | Upload, sharing, view and backup workflows |
| `src/protocol` | Bundle format and typed queue-delta reconciliation |
| `src/infrastructure` | Bun/Cloudflare entrypoints, SQLite, R2/S3, timers and RPC |
| `src/http` | Hono routes, authentication and HTTP validation |
| `src/web/server` | Production SSR pages |
| `src/web/client` | Browser entrypoints, feature controllers and shared presentation |
| `src/sdk` | Source of the standalone `k.mjs` client |

Domain code may depend on protocol code and persistence interfaces, never
browser presentation. HTTP translates typed domain errors to status codes.
The Cloudflare adapter explicitly serializes these errors as tagged values;
custom JavaScript Error properties are not the RPC contract.

The namespace feature lives in `src/web/client/features/namespace`. Its composer
preview owns its object URLs; its live controller uses the pure, typed queue
reducer. Shared formatting opts into JavaScript type checking; migration of
other browser controllers to checked TypeScript remains incremental.

`public/k.mjs` is a checked-in distributable copied from `src/sdk/k.mjs` by
`bun run build`. Change the SDK source, then build. `ops/version.ts` updates
both copies. The Bun server serves the SDK source directly, so starting it
does not require a build. Other public assets and the protocol remain at the
same URLs. No protocol or persisted-item format migration is required.

## Storage and failures

The Hub reserves incoming bytes synchronously before namespace mutations.
Reservations cover sends, replacements and restores, using actual item sizes
rather than trusting the HTTP Content-Length for quota accounting. The early
HTTP quota check is only a preflight. A replacement or import conservatively
needs room for its whole incoming contents, not just the final size delta.

Each namespace persists a unique reservation token before contacting the Hub.
Its final report includes committed byte usage and completed tokens. A pending
operation keeps its reservation until its mutation settles. A retry alarm is
persisted before the reservation RPC; later reports and restart recovery can
release interrupted operations' reservations. Reservations never expire merely
because an operation took a long time. Known precommit domain refusals discard their unused uploaded blobs.
If the Hub is unavailable, writes fail
closed; space can remain reserved until reconciliation succeeds.

The budget is per backend in a sharded Bun installation. It measures retained
logical item bytes and reservations, not all physical bytes in an S3 bucket.
After an ambiguous upload RPC failure, the service looks up the immutable
object key to acknowledge a commit whose reply was lost. If that cannot
confirm a commit, it retains the blob, since the namespace may have committed
it already. This prevents data loss but can leave orphaned blobs;
automated bucket garbage collection is not implemented. Do not delete such
objects on a timeout alone.

An object read first opens storage, then atomically claims the exact item ID
and object key. Concurrent last readers cannot both succeed. A missing object
or a storage-open failure consumes no read. A stream that fails after a
successful claim still consumes that read. Texts with limited reads cannot
acquire public names through either sending or renaming.

## Isolated Solid SSR pilot

The experiment in `experiments/solid-namespace` has its own client and SSR
builds. It is not imported by the production app, deployed by Wrangler, or
shipped in the container's production dependencies. Solid and its compiler
are development dependencies only.

```sh
bun run pilot:start
# Builds and starts a temporary local backend automatically.
# No S3/Garage configuration is required.
# Open http://127.0.0.1:3100/pilot/example
```

The default demo stores SQLite in a temporary directory and blobs in memory;
its data is discarded on exit. To use an existing backend instead:

```sh
PILOT_UPSTREAM=http://127.0.0.1:3000 bun run pilot:start
# If 3100 is occupied:
PILOT_PORT=3101 bun run pilot:start
```

An explicitly configured upstream must already be running. Connection failures
produce a readable 502 response. `pilot:start` always builds the renderer and
client before starting, so it also works from a clean checkout.

PILOT_UPSTREAM may include an instance base path. Use a local, disposable
instance for this experiment. The prototype binds to loopback. It renders
initial plain-namespace rows on the server, hydrates a single Solid-owned
root, sends plain text and refreshes every five seconds. It uses a nonce for
the hydration bootstrap and strips limited-item previews from its snapshot.
It does not fetch read-limited contents until the explicit download action.

This is a feasibility prototype, not feature parity: it does not implement
WebSocket updates, encryption, file composition, editing, sharing, themes,
clipboard or authentication UI. The production interface remains the default.
Encrypted content must continue to be decrypted in the browser: fragment keys
must never be sent to SSR. A full migration requires browser coverage for all
these behaviors and a measured maintenance benefit, not just a successful
SSR build. Client bundle sizes printed by Vite include the framework and the
prototype but are not a production performance comparison.

## Verification

`bun run test` builds assets and runs Workers and Bun integration tests,
including failure, quota, router and protocol regressions. `bun run typecheck`
and `bun run lint` check the production tree. `bun run pilot:test` builds the
optional experiment and tests its server rendering separately.

`bun run test:browser` builds the pilot and uses Playwright to start disposable
Bun and pilot servers. It checks hydration under CSP, sending without page
navigation, production live updates and read-budget preservation. Install the
Playwright Chromium browser first (`bunx playwright install chromium`). On
NixOS, the browser needs the system's compatible library environment;
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` can select a compatible executable.
