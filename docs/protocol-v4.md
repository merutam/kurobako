# Protocol v4 (draft)

The next version of the Kurobako protocol. It is a working plan: once built,
its contents move into the protocol page (`public/protocol.html`) and this
file goes away. Kurobako is in early development, so v4 does not keep v3's
encrypted namespaces readable: a name gives another ID under v4, and v3
items are left to expire. Plain namespaces are not affected.

## 1. One derivation, every key from it

    K           = PBKDF2-SHA256(normalized name, salt "kurobako/v4", 600,000 iterations), 32 bytes
    ID          = HKDF-SHA256(K, info "kurobako/v4/id"), 16 bytes, base64url (22 characters)
    namespace key = HKDF-SHA256(K, info "kurobako/v4/namespace"), 16 bytes (AES-128, AES-KW)
    write key   = HKDF-SHA256(K, info "kurobako/v4/write"), 16 bytes, base64url in Write-Key

HKDF with an empty salt throughout. One PBKDF2 run, as in v3: opening a
namespace costs the same, and so does each guess at a name. A read-only link
carries the ID and the namespace key but not K, so it cannot lead to the
write key.

## 2. Locked namespaces (built for plain namespaces)

As in "Locked namespaces" on the protocol page: `POST <ns>/lock`, `DELETE
<ns>/lock`, the `Write-Key` header, `Locked: 1` on `ls`, `"locked"` in the
live queue, 401/403, no burn-after-reading items. An encrypted namespace
locks with the write key of section 1, so its owner never handles a key.

**Read-only link:** `/e#/<base64url(ID ‖ namespace key)>`, 43 characters. An
empty name before the `/` is not a valid name, so the form is free. Whoever
has it reads everything (and plays it, section 3) and writes nothing.

## 3. Segmented body

Every encrypted item's contents, texts included:

- **Body key:** `HKDF-SHA256(item key, info "kurobako/v4/body/<rev>")`, 16
  bytes, where `rev` is the item's revision (section 4), 0 when sent.
- **Segments:** the contents cut into `S = 65536`-byte pieces, the last
  shorter but never empty. Each is `AES-128-GCM(body key, nonce, piece)`:
  `S + 16` bytes.
- **Nonce:** 12 bytes, the segment's number in 11 big-endian bytes, then 1
  byte: `0x01` for the last segment, `0x00` otherwise. Segments cannot be
  reordered, dropped from the end or spliced from another body.
- **Body:** the segments, one after the other; no header, no stored IV.
- **Size:** with `n` bytes of contents in `k = ⌈n / S⌉` segments, the body is
  `n + 16k` bytes. From the body's size `c`: `k = ⌈c / (S + 16)⌉`,
  `n = c − 16k`.
- **Reading a part:** bytes `[a, b]` of the contents are in segments `a ÷ S`
  to `b ÷ S`; segment `i` starts at `i · (S + 16)` in the body. A client asks
  for those with `Range` (served by every file, encrypted ones included),
  opens them and cuts the ends.

Metadata stays a sealed JSON (`{"title"}` for a text, `{"filename", "mime"}`
for a file), now with `"rev"` when above 0, sealed with the item key under
the label `kurobako/v4/metadata`; the item key is wrapped with AES-KW as in
v3.

**Playing and downloading in the browser:** a Service Worker (`sw.js`) holds
the keys of the items open in the page (sent with `postMessage`, asked back
from the page when the worker was restarted), and answers a virtual URL
(`…/k/stream/<id>`, `?download` for a download) by fetching the sealed parts
a `Range` needs, opening them and answering `206`. Without a Service Worker
(some private windows), the page opens the whole body and plays it from a
blob.

## 4. Editing texts (after v4)

A text's contents can be replaced, keeping its ID, position, expiry and
share link: `POST <ns>/<item>/e` with the new text, a write like any other.
The client sends the `updatedAt` it saw; if the item changed since, `409`.

An encrypted text is sealed again under `rev + 1`: a new body key, so a nonce
is never used twice under one key, while the item key (and every share link
carrying it) stays the same. The request carries the new body and the
metadata sealed again with the new `rev`, under the same wrapped key.

Files and burn-after-reading items stay as sent. A backup restores a newer
`updatedAt`'s contents over older ones.

**Language:** a text's language comes from its name's extension
(`script.py`, `notes.md`), so it needs no field of its own and works the
same encrypted, where the name is sealed. The editor's language picker only
changes the extension. Highlighting uses highlight.js (BSD-3-Clause),
served from `public/vendor/` like the QR code library, never from a CDN;
without an extension, it guesses. Markdown shows as highlighted source, not
rendered HTML.

**Also after v4:** an expiry per send (`Expires-In: <seconds>`, shorter than
the instance's), and a read limit generalizing burn-after-reading (burn is
a limit of one).

## 5. Discovery

`/.well-known/kurobako` gains `"protocol": 4`; k.mjs compares it with its
own and says so when they differ.

## Order of work

1. Locked plain namespaces (done).
2. The v4 derivation and locked encrypted namespaces: HKDF, read-only links,
   test vectors (done).
3. The segmented body, with `rev`, in k.mjs and the page (done).
4. The Service Worker: playing and downloading in parts.
5. `"protocol": 4`, the protocol page and the README.
6. Editing texts.
