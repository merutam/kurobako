# Development

The API and the encrypted formats are documented on every instance at
`/k/protocol` (`src/web/server/documents/protocol.html`). This file is what the
code and that page do not say.

## Layout

Hono owns routes, authentication and responses; pages are rendered with Hono
JSX. Bun and Cloudflare share everything but their adapters.

| Directory | What it holds |
| --- | --- |
| `src/domain` | Namespace rules (`namespace/`), the hub, contents, archives, push requests |
| `src/application` | Sends, edits, shares, views and backups over the domain |
| `src/protocol` | Bundle format and the live queue reducer |
| `src/http` | Routes and HTTP validation; domain errors become status codes |
| `src/infrastructure` | Bun and Cloudflare entrypoints, SQLite, S3/R2, timers, push sending |
| `src/web/server` | Pages |
| `src/web/client` | Browser code: `pages/` (one bundle each), `features/namespace/`, `lib/`, `shared/` (also run on the server) |
| `src/sdk/k.mjs` | The standalone client; `bun run build` copies it to `public/k.mjs` |

- Rows are one template, `shared/item-row.js`, given the server's string `h` or
  the browser's DOM `h`. The browser adopts the server's rows by hash
  (`data-made`) instead of rebuilding them. A namespace, a shared view and a
  shared item are the same list (`features/namespace/item-list.js`) over
  different modes (`modes.js` documents the contract).
- `NamespaceCore` is one Durable Object (one SQLite file on Bun). Its tables
  have their own modules beside it; the Cloudflare adapter serializes domain
  errors as tagged values for RPC.
- No front-end framework: Solid was weighed for the composer and left out (its
  runtime alone would put the namespace page over the bundle budget, and Bun
  does not compile its JSX).

## Guarantees worth keeping

- **Storage budget.** A namespace journals a reservation token before asking
  the hub, and reports committed bytes after. A failed report never fails a
  committed write: the journal and a retry alarm reconcile it. If the hub is
  down before reserving, writes fail closed. The budget is per backend.
- **Blobs.** Uploads go to storage before the namespace commits. A known
  refusal (write denied, view changed, storage full) deletes the upload; an
  ambiguous failure keeps it (it may be committed) and looks the object key up.
  Object deletes are journaled and retried by the alarm. Never delete a blob on
  a timeout alone.
- **Limited reads.** A read opens storage first, then claims the item and
  object key atomically: a storage failure consumes nothing, a broken stream
  after the claim consumes the read. Limited texts never get public names.
- **Item IDs** can be drawn again once an item is gone, so removing an item
  drops it from the active view and forgets its share links, and new IDs avoid
  those frozen views still list.
- **Cleanup** re-checks that a namespace is still empty after every await.

## Shared views

A view's membership is frozen when another view replaces it; its items stay
live (edits show, deleted items drop out). Only a writer lists or rotates
views; rotation succeeds only against the item order and active view the
writer read, so no committed item misses the view active at its commit.

The browser clone sends through the destination's own mode as new items
(new IDs and keys, instance defaults for expiry and reads, `No-Dedup`). It is
not a snapshot: an item that changes while it is read is skipped, and an
interrupted clone says how far it got.

Not done: encrypted backups cannot be imported into a namespace with an active
view (409, as the client would have to reseal view entries), and the public
listing of views (`/p`) is on hold.

## Design

Kurobako reads like a terminal: one monospaced typeface, 1 px borders, one
accent. Values live in `src/web/client/styles/tokens.css`; the `/k/theme`
presets only change those tokens on a visitor's device.

- The accent marks only what is clickable or selected, and heading prefixes
  (`#`, `##`, hidden from screen readers). `ok` and `err` mark states.
- Boxes only for blocks with their own header; lists are rows, never cards.
- Buttons by weight: one primary per screen; bordered secondary buttons for
  complete actions; bracketed words (`[copy]`) for a row's or a field's.
  Choices read `open: one [several] [all]`. Words, not icons; no emoji.
- Instant: no animation, spinner or skeleton (the Top button's scroll, which
  respects reduced motion, is the one motion). No shadows, gradients or blur.
- Clickable things are at least 44 × 44 px, focus shows in the accent, body
  text keeps 4.5:1 contrast, and reading works without JavaScript.

## Checks

```sh
bun run test           # build, Workers (vitest) and Bun tests
bun run typecheck
bun run lint
bun run test:browser   # Playwright; needs Chromium: bunx playwright install chromium
```

`test/shared/` runs against both the Worker and Bun; `test/bun/` is the Bun
server end to end (each file starts its own server from `harness.ts`);
`test/regressions.test.ts` holds focused regressions; `test/browser/` drives
the pages. On NixOS, point Playwright at a system browser with
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`.

The build fails when a page's first JavaScript passes 100 kB minified and
prints every page's size. `src/worker-configuration.d.ts` is generated by
`bun run types` (typecheck runs it).
