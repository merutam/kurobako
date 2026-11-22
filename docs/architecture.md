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

The namespace feature lives in `src/web/client/features/namespace`. `forms.js`
wires the composer and owns sending and editing over `composer-text.js` (tabs,
editor, Markdown preview), `composer-files.js`, `sending.js` (including the
send-limit wait), `bundle-compose.js` (no DOM) and `send-settings.js`;
`page-tools.js` holds backup, restore and the page link. `item-list.js` renders
and adopts rows over `item-actions.js`, `item-rename.js` and `expansion.js`.
`modes.js` documents the `Mode` contract the three modes share. The composer
preview owns its object URLs; the live controller uses the pure, typed queue
reducer. Shared formatting opts into JavaScript type checking; migration of
other browser controllers to checked TypeScript remains incremental.

`NamespaceCore` (`src/domain/namespace/index.ts`) keeps a namespace's rules and
storage; its parts with their own state or no state at all live beside it:
`queue.ts`, `views.ts`, `access-log.ts`, `subscriptions.ts` (push),
`journal.ts` (unreported reservations, pending object deletes), `restore.ts`
(merge rules) and `live.ts` (deltas for viewers).

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

### Decision: the composer stays without a framework (2026-11-22)

After the composer was split (`forms.js` and its modules, about 1,060 lines in
seven files, each with one job and browser tests), Solid was weighed for it as
a client-only island. It was not adopted:

- Solid's runtime alone is 18.1 kB minified (7 kB gzip). The namespace page's
  first JavaScript is 85.3 kB, so it would pass the build's 100 kB budget
  (`PAGE_JS_BUDGET` in `src/web/client/build.ts`).
- Bun.build does not compile Solid's JSX: the assets would need Vite or a Babel
  plugin, a second toolchain for one feature.
- SSR already exists (Hono JSX and the shared `item-row.js` template with row
  adoption), and encrypted namespaces cannot be rendered on the server anyway.
- What remains imperative is mostly `composer-text.js` (tabs and the editor),
  about 25 DOM updates, now behind a small API.

Revisit if the namespace page's JavaScript drops well under the budget, or if
the composer grows enough state that the imperative updates become the
maintenance cost.

## Verification

Tests: `test/shared/` runs against both the Worker and Bun; `test/bun/` is the
Bun server end to end (each file with its own server, from `harness.ts`);
`test/regressions.test.ts` holds focused regressions; `test/browser/` is
Playwright.

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
