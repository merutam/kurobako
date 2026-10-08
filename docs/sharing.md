# Namespace write access and shared views

Protocol v6 uses the namespace address as its write capability and has no
lock or first-upload ownership. Shared views and browser-side cloning are now
implemented. A view follows new items while active; its membership freezes
when another view replaces it. The public listing remains on hold.

## Two ways to enter a namespace

The namespace's own address is its write capability. Someone with it can
read and perform all ordinary mutations (send, edit, rename, delete, import,
and create item shares):

- **Plain:** knowing `/<ns>` is enough. This address can reach the server,
  appear in logs, and be guessed if chosen weakly. There is no claim on first
  upload and no separate owner credential.
- **Encrypted:** knowing the complete secret name in `/e#<secret name>` lets
  the client derive the namespace's decryption key and a separate write
  credential. Every mutation must prove possession of that write credential,
  including the first upload. Neither the name nor the decryption key is sent
  for authorization. Anyone sharing the complete name shares write access;
  there is no first uploader with special rights.

Reading a shared view or an individual item does not confer write access.
There is no lock/unlock state. The older encrypted `/e#/<token>` link
(ID plus namespace key) remains read-only by server authorization; it is not
a shared view and still reveals the namespace ID. A URL that discloses
the namespace ID alone does not authorize an encrypted mutation.

Protocol v6 binds the encrypted ID to the write key with a one-way hash, so
the server can verify a write even on the first upload. v5 encrypted namespace
IDs are not reinterpreted.
For plain, the path itself is the capability, with the unavoidable exposure
that entails. These choices remove owner/lock transitions, but writes still
need a final authorization check at their commit point, especially after an
asynchronous blob upload.

## A shared view: active membership, live items

Creating a view includes the current item set and order. It produces a
shareable link that does **not** reveal the source namespace's plain name,
encrypted ID, complete secret name, namespace key, or write credential. The
link resolves an index of **individual item-share links**; it does not clone
item bytes. Existing `/i/<token>` links hide their source namespace. For an
encrypted item, its link carries only that item's key in the fragment, not
the namespace key. The index must not expose an API path back to the source
namespace. The visitor sees a read-only page and downloads through these
item-share routes.

While a view is active, new sends add their items to it. Creating another
view manually freezes the previous one's membership; only the new view
follows later sends. Exactly one view is active per namespace. "Frozen"
applies to **which item IDs are included**, not to their contents:

- An edit or rename of an included item is visible through its existing
  share link. Its item key and share token remain stable across text edits.
- If an included item is deleted, burned, or expires, its link stops opening;
  the view may omit that dead entry when rendered.
- A new source item is added only to the active view. Reordering an item in
  the source does not silently change a frozen view's captured order.

Call an old view a *frozen-membership view*, not a full immutable snapshot.
Someone who needs exact old bytes must make a backup or a separate copy. Views
created at different times are independent. Rotating to a new view does not
revoke the old link. Revoking the index link cannot retract individual item
links already copied by visitors; item
deletion or expiry still makes those links stop working.

For plain, the index stores member IDs internally without putting the source
name in the public response. For encrypted, the client holding the complete
name obtains each item's key and builds independently encrypted view entries.
Each entry contains that item's key sealed under the view's read key; the
server creates an opaque item-share token when serving the entry. This per-item
form lets the server append an opaque entry without decrypting or rewriting
the entire index. The view read key is derived by the
client from the full namespace secret and a fresh, public, random view ID
(canonical unpadded base64url of 16 random bytes),
with a dedicated domain-separation label; it lives only in the share URL's
fragment. A visitor decrypts the entries, then loads each item through its
individual share link. The URL is `/v/<token>#<base64url(view key)>`. The
16-byte view key is HKDF-SHA-256 from K with empty salt and info
`kurobako/v6/view/<view ID>`. Each envelope is base64url of a random 12-byte
IV followed by AES-128-GCM ciphertext and tag for the 16-byte item key, with
AAD `kurobako/v6/view-entry/<view ID>`. Neither
the full secret nor the namespace key belongs in the view link. No item-body
duplication or server-side decryption is required.

## Adding items and rotating views

An encrypted send computes an extra envelope for the currently active view:
the new item's key sealed under that view's read key. It sends `View-Token`
and `View-Envelope`; a stale or missing pair gets 409. The server commits the item and its view
entry as one logical operation; a successful send cannot silently omit the entry.
Plain sends add their entry server-side. A namespace may have no
view, in which case sends need no view envelope. Edits and renames keep the
existing item key and link, so they need no new envelope. Deletion/expiry
invalidates the corresponding item link; it need not erase old membership.

To rotate, the client with write access reads a consistent list of the
current items, derives a new read key from a new view ID and, for encrypted
items, seals their keys into the new view's entries. The server accepts the
complete new view only if the item IDs in order and previous active-view token still match,
then atomically makes it active and freezes the previous view. A concurrent
send commits against either the old or new active-view version; a stale send
or rotation fails and retries. There must be no gap where a committed item is
missing from the view active at its commit. Creating and routing item-share
tokens may involve separate storage components; the implementation must make
that publication idempotent/recoverable and must not expose a partial view.

The server keeps a catalog of view IDs/tokens, creation times, active/frozen
state, membership, and opaque envelopes. Only a writer may enumerate or
rotate that catalog; a view visitor cannot enumerate it. The server never
stores the view read keys, item keys, or full encrypted namespace secret in
clear. An encrypted writer on a different device can list historical view
IDs and rederive their read keys/links from the full secret; no browser-local
history is required. A plain writer can list the links directly (knowing the
plain namespace address already grants write access). View records and their
routing indexes are removed with the source namespace; they are not a
separate permanent claim or backup. Retaining old links until then has a
storage cost; the current limit is 100 views per namespace, returning 409
instead of silently discarding frozen views.

An opt-in public listing can publish a view link instead of the source
namespace address. This is a separate presentation choice, not a lock or a
transfer of ownership. For encrypted, anyone who opens the published view
receives the *included items'* keys, which is necessary to read them; the
source namespace key and unpublished items remain undisclosed. Unlisting
cannot revoke links someone already saved. For plain, publishing the view
does not publish `/<ns>` through the view itself, although a weak name can be
guessed independently.

## Clone a view into an independent namespace

Anyone who can read a shared view can request a clone into a **new, empty**
namespace they choose and control. This works for plain and encrypted source
views, and either mode may be chosen for the destination. The client takes
the view's current member list once, reads each still-available item's bytes
through its share link, and sends them as **new items with new IDs** (and new
item keys when the destination is encrypted). It preserves names and content
where possible, but not source IDs, share links, creation dates, remaining
expiry or read budgets. The destination
uses the instance defaults for expiry and read limits. For encrypted sources,
decryption happens in the cloning client; for encrypted destinations, that
client encrypts again with fresh destination keys. Neither server needs the
source's namespace secret or the view key.
Plain destination sends use `No-Dedup: 1` so equal source bytes still become
distinct items.

The clone has no subscription or pointer back to the source: later sends,
edits, deletions and view rotations in the source do not affect it. Likewise,
destination edits do not affect the source. An active view can gain items
during a clone, but those arriving after the member list was captured are not
part of that attempt. Existing items can still change or disappear while
their bytes are being fetched. Without immutable source revisions, this is
**not an atomic point-in-time snapshot**: the client should detect changed
revisions where possible and retry or report them, rather than silently
claiming an exact snapshot. Interrupted clones can leave a partial new
namespace; report that explicitly and do not present it as complete.

Cloning a read-limited item requires an explicit consuming read and may
exhaust its budget; never preload or silently consume it as part of cloning.
The user must choose whether to include such items, and a failed/expired
read is reported as missing. A view link already permits downloading its
included contents, so cloning does not grant additional source privileges.

## Implementation boundaries

The shared Bun/Workers API enforces encrypted write authorization on
every mutating route at the final namespace operation, not just at request
preflight. Share-view creation must gather a consistent set of item IDs and
item-share tokens; an item removed during creation is omitted or reported,
not published as an unexplained broken entry. The client must never mistake
a partial encrypted index for a complete view. The view token and its index
need the same namespace-lifecycle cleanup as item shares, without duplicating
S3/R2 objects. Preserve the existing per-item `If-Match` behavior: it is why
an edit can update a shared item without detaching its metadata from its body.

Server and CLI tests cover view creation, source-name/key non-disclosure,
active and frozen membership, concurrent rotation, multi-server routing,
cleanup and encrypted write authorization. The browser clone still needs
end-to-end tests for both destination modes, partial copies and changed
source items. Encrypted backup import into a namespace
with an active view currently returns 409: it cannot invent envelopes for
imported item keys. A client-side import that reseals view entries is needed
before those imports can join an active encrypted view.
