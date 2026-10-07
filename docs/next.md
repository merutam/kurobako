# After protocol v5

Protocol v5 is built and described on the protocol page
(`public/protocol.html`): one derivation for every key, locked namespaces
and read-only links, contents sealed in segments with a revision, the routes
(the first path segment is the protocol's, the server's own things live under
`/k`) and `"protocol": 5` in `/.well-known/kurobako`. The browser plays and
downloads encrypted contents in parts through a Service Worker
(`public/sw.js`, at `/k/stream/<token>`, never seen by the server).

What comes next, in order. Each moves to the protocol page once built, and
this file goes away with the last.

## 1. Live updates for scripts (done)

`k.mjs <link>/live` stays connected and prints one line per change, the
encrypted ones decrypted: `new <id> <name>`, `changed <id> <name>`,
`gone <id>`, `locked`,
`unlocked`. It reconnects by itself and, after reconnecting, prints only
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

`/p`, a page, and `/p/ls?after=<cursor>`, its JSON, list the namespaces
their owners chose to show: a wall of walls. `p` becomes a reserved name.

- **Opt-in, locked only:** a locked namespace's owner turns listing on and
  off with its write key (`POST`/`DELETE <ns>/list`). Without a lock anyone
  could publish in its name, so an open namespace cannot be listed.
- **Encrypted:** listing one publishes its read-only link: an explicit
  choice of its owner, who can unlist it (the link keeps working for whoever
  has it).
- **Order and paging:** most recently active first; the cursor is
  `(updatedAt, id)` of the last one shown, stable while namespaces change
  between pages.
- **Moderation:** the admin can take a namespace off the list; an instance
  may cap how many are listed.

## 4. Smaller ones

- An expiry per send (`Expires-In: <seconds>`, shorter than the instance's).
- A read limit generalizing burn-after-reading (burn is a limit of one).
