# After protocol v6

The namespace-address write capability, shared views and browser-side cloning
are implemented in protocol v6; the details and current encrypted-import
limitation are in [`sharing.md`](sharing.md). One active view gains new items,
while older views retain frozen membership but live item content. The earlier
ownership/lock proposal is superseded.

Protocol v6 is built and described on the protocol page
(`public/protocol.html`): one derivation for every key, write capabilities
and read-only links, contents sealed in segments with a revision, the routes
(the first path segment is the protocol's, the server's own things live under
`/k`) and `"protocol": 6` in `/.well-known/kurobako`. The browser plays and
downloads encrypted contents in parts through a Service Worker
(`public/sw.js`, at `/k/stream/<token>`, never seen by the server).

What comes next, in order. Each moves to the protocol page once built, and
this file goes away with the last.

## 1. Live updates for scripts (done)

`k.mjs <link>/live` stays connected and prints one line per change, the
encrypted ones decrypted: `new <id> <name>`, `changed <id> <name>`,
`gone <id>`. It reconnects by itself and, after reconnecting, prints only
what changed since. Scripts get from it what a webhook would give, without
the server calling out.

## 2. Editing texts (done)

A text's contents can be replaced, keeping its ID, position, expiry and
share link: `POST <ns>/<item>/e` with the new text, a write like any other.
The client sends the `updatedAt` it saw (or `createdAt` before the first
change) as a quoted `If-Match`; if the item changed since, it gets `412`.

An encrypted text is sealed again under `rev + 1` with a new random `bodyId`
in the authenticated metadata. That ID makes the body key unique even for
concurrent attempts from the same revision; the item key and share links
stay the same. The request carries the new body and resealed metadata.

Files and burn-after-reading items stay as sent. A backup restores a newer
`updatedAt`'s contents over older ones.

**Language:** a text's language comes from its name's extension
(`script.py`, `notes.md`), so it needs no field of its own and works the
same encrypted, where the name is sealed. The editor's language picker only
changes the extension. Highlighting uses highlight.js (BSD-3-Clause),
served from `public/vendor/` like the QR code library, never from a CDN;
without an extension, it guesses. Markdown shows as highlighted source, not
rendered HTML.

## 3. Public listing (on hold)

`/p`, a page, and `/p/ls?after=<cursor>`, its JSON, may list shared views
their creators chose to publish, without exposing the source namespaces.
`p` becomes a reserved name. The view model is in [`sharing.md`](sharing.md).

- **Opt-in:** publication is separate from creating a view. Removing one
  from `/p` does not invalidate a link someone already saved.
- **Plain or encrypted:** publish the view link, not the namespace's write
  address or its encryption key.
- **Order and paging:** most recently active first; the cursor is
  `(updatedAt, id)` of the last one shown, stable while namespaces change
  between pages.
- **Moderation:** the admin can take a namespace off the list; an instance
  may cap how many are listed.

## 4. Per-send expiry (implemented)

`Expires-In: <seconds>` on a send requests a positive integer number of
seconds from the item's commit time, no longer than the instance's configured
item TTL. If the instance has no item TTL, any positive duration within an
explicit implementation bound may be requested; absent the header, retain
the instance default (including no expiry). Reject malformed, zero, and
out-of-range values rather than silently clamping them. A duplicate-content
send that moves an existing item to the top uses the new send's requested
expiry, just as it uses today's default expiry. Return the effective
`expiresAt` in the item as today. Imports retain the backup's expiry and
remain bounded by instance policy; this header is for sends, not imports.
Both plain and encrypted items use the same server-enforced deadline.

## 5. Read limits (implemented)

Generalize `Burn: 1` to `Reads: <positive integer>`. `Burn: 1` remains an alias for
`Reads: 1`; conflicting headers are rejected. A limited item records its
remaining successful *claims*, not a count inferred from access logs. The
namespace atomically reserves one claim before delivering content, on every
route that can serve it, including item-share links. The last claim removes
the item, as burn does today. A started stream consumes a claim even if the
client disconnects; failed authorization, missing content, and list/metadata
requests do not. Concurrent readers cannot exceed the limit.

For limited items, do not expose text bodies or text-derived names/previews
through listings, summaries, views, archives, or JSON before a claim.
Backups/archives omit them, as they already omit burn items. The UI must
require an explicit open/download action rather than consuming claims while
rendering a list or preloading media. As with current burn, limited file
reads return the whole object without `Range` support: a video player that
seeks by making several requests would otherwise consume several claims.
This is an explicit limitation until a separately designed read-session
protocol exists. Disable content deduplication and text editing for limited
items, matching current burn behavior. Expiry and read limit are independent:
whichever removes the item first wins, and an expired item cannot be claimed.

The API, browser, `k.mjs`, backup format, Bun and Workers implementations,
and tests must use the same semantics. Cover malformed headers, deduplicated
sends with a requested expiry, concurrent claims, interrupted streams,
item-share routes, encrypted items, and expiry racing the last claim.

## 6. Clone a shared view (implemented in the browser)

Offer a client-side clone from a read-only shared view into a new namespace
controlled by the visitor. Both source and destination may be plain or
encrypted. Re-send available contents as new items; do not carry over source
IDs, share links, expiry/read budgets, or future changes. Encrypted contents
are decrypted and, if needed, re-encrypted in the client. The operation is
not an atomic source snapshot and may leave a partial destination if it
fails; the UI must say so. Read-limited items require explicit consent to
consume a claim. The full semantics are in [`sharing.md`](sharing.md).
