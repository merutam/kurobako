# Kurobako

A web clipboard with short queues kept apart by namespace. Open `/myns` on
your phone and on your computer to share the same box: no accounts, the 20
newest items kept, each expiring after a day.

- **Plain** (`/myns`): the server stores what is sent, and everything works
  with `curl`.
- **Encrypted** (`/e#name`): the client encrypts everything; the name, after
  the `#`, never reaches the server. Anyone with the name can read, so use a
  long one (*Random name* on the home page makes 80 bits).

It runs on Cloudflare Workers or as a self-hosted Bun server.

## Command line

`BOX` is the address of a Kurobako instance and `ns` a namespace name:

```sh
BOX=https://kurobako.mugens.org
curl $BOX/ns/ls                    # the queue as JSON, newest first
curl $BOX/ns/1                     # the newest item's contents
curl $BOX/ns/1.json                # its details and a share link
curl -OJ $BOX/ns/1/d               # saved under its own name
curl -d 'hello' $BOX/ns/new        # send a text
curl -T photo.jpg $BOX/ns/         # send a file
curl -H burn:1 -d 'once' $BOX/ns/new   # deleted when first read
curl -H 'If-Match: "<updatedAt-or-createdAt>"' -d 'changed' $BOX/ns/1/e
curl -d 'new name' $BOX/ns/1/n     # rename
curl -X DELETE $BOX/ns/1           # delete
curl $BOX/ns/1/s                   # a link to share it
```

An item is its position (1 is the newest), its six-letter ID (which never
changes) or its name, even cut short (`$BOX/ns/report` finds
`Report 2024.pdf`). A text is named by its start until renamed.

For encrypted namespaces, [`/k.mjs`](public/k.mjs) takes the same options and
paths as curl, with `e#name` in place of the namespace, and does the
encryption (Node 20+ or Bun, no dependencies):

```sh
curl -O $BOX/k.mjs
node k.mjs "$BOX/e#secret name"                # the items, one per line
node k.mjs "$BOX/e#secret name/1"              # an item's contents
node k.mjs -d 'hello' "$BOX/e#secret name/new"
node k.mjs -d 'changed' "$BOX/e#secret name/1/e" # edit if unchanged meanwhile
node k.mjs -O "$BOX/e#secret name"             # export every item here (overwrites)
node k.mjs -X POST "$BOX/e#secret name/views"   # create a read-only shared view
node k.mjs "$BOX/e#secret name/live"           # a line per change, until stopped
```

`/live` stays connected and prints `new <id> <name>`, `moved`, `changed`,
`gone <id>` as they happen, for scripts; it works on
plain namespaces too, and reconnects by itself (Node 22+ or Bun):

```sh
node k.mjs "$BOX/e#secret name/live" | while read -r event id name; do
  [ "$event" = new ] && node k.mjs -OJ "$BOX/e#secret name/$id/d"
done
```

With [Nix](https://nixos.org/), `nix run github:merutam/kurobako#k -- <options> <link>`
runs it without Node installed. `node k.mjs` lists everything it does. The whole protocol, plain and
encrypted, is at `/k/protocol` on every instance. Every instance describes itself
(base path, version, limits) at `/.well-known/kurobako`.

## Behavior

- **A namespace exists once something is sent to it**, so opening random
  names creates nothing. Once its items are gone, it is
  deleted after an hour.
- **Limits:** texts up to 1 MB, files up to 100 MB, 30 sends a minute per
  address (an IPv6 /64 network counts as one).
- **Guessing names gets slow:** an address that asks for 30 namespaces, items
  or share links that are not there in a minute reads nothing for the rest of
  it. Plain names are still best long: a short one is easy to find.
- **File types** come from the bytes: PNG, JPEG, GIF, WebP, AVIF and HEIC are
  shown as images; anything else is a download.
- **Burn after reading** (`Burn: 1`): only one reader gets the item.
- **Per-send limits:** `Reads: 3` permits three explicit content reads;
  `Expires-In: 3600` expires an item after an hour, within the instance limit.
- **No copies:** sending contents already in a plain queue moves that item to
  the top (`200` with `"existing": true`); a clone uses `No-Dedup: 1` to
  preserve distinct source items with identical bytes.
- **Share links** (`/i/<token>`) open one item without revealing its
  namespace, and die with it. Encrypted ones carry the item's key after the
  `#`.
- **Shared views** (`/v/<token>`) list item links without revealing the source
  namespace. The active view gains new items; older views keep their member
  list but show edits to those items. The view page can clone available items
  into a new, independent plain or encrypted namespace.
- **Live:** open pages get every change over a WebSocket.
- **Access log** at `<ns>/log`. The home page shows aggregate stats only,
  counted from page views, whose address and country are kept for a day.

## Backups

A namespace comes out whole as a zip or a tar, and goes back the same way.
Encrypted items stay encrypted in it, so a backup needs no secret:

```sh
curl -OJ $BOX/ns/zip                       # ns-2026-10-06.zip (or /tar)
curl -OJ "$BOX/ns/zip?since=2026-10-01"    # only what was sent or changed since
curl -T ns-2026-10-06.zip $BOX/ns/import   # put back (into any plain namespace)
node k.mjs -O "$BOX/e#secret name"         # every item, decrypted, into this folder
```

Like curl, `k.mjs -O` overwrites a local file of the same name; add
`--no-clobber` to refuse. It exports but does not synchronize a folder. An
extracted plain backup accepts `./backup`, `./backup/ls`, `/1`, `/item-id` and
`/1.json`; in a full backup, select one as `./backup/plain/<namespace>/ls`.
Encrypted backups use `./backup#secret name/ls`, and `-O` on the bare link
exports their decrypted items. A `.sealed` file can also be printed directly
with the same `#secret name`. `KUROBAKO_SECRET` may carry the name instead.
Keep `manifest.json` beside the extracted files.

With `ADMIN_KEY` set, `/k/a/zip` and `/k/a/tar` back up every namespace, and
`/k/a/import` restores them:

```sh
curl -H "Authorization: Bearer $ADMIN_KEY" -o backup.tar $BOX/k/a/tar
```

Import merges: a newer revision replaces a text with the same ID; files stay
immutable, and nothing is deleted. Incremental backups omit deletions; restore
a full snapshot into an empty instance for an exact copy. Items that burn after
reading are left out.

A backup also comes in parts, each a whole backup of its own items, for
anything with a request size limit (Cloudflare takes 100 MB per request):
`?max=<bytes>` stops a part at about that size, and its `X-Kurobako-Next`
header, given back as `?after=`, starts the next one. The last part has none:

```sh
next=
while :; do
  curl -fsS -OJ -D head -H "Authorization: Bearer $ADMIN_KEY" \
    "$BOX/k/a/zip?max=90000000&after=$next" || break
  next=$(sed -n 's/^x-kurobako-next: *//Ip' head | tr -d '\r')
  [ -n "$next" ] || break
done
for part in kurobako-*-part*.zip; do
  curl -fsS -H "Authorization: Bearer $ADMIN_KEY" -T "$part" "$BOX/k/a/import"
done
```

## Write access

A plain namespace's name lets anyone who knows it write. An encrypted
namespace requires the write key derived from its complete secret name on
every mutation, including the first upload. Share links never carry that key.
The old lock endpoint is disabled.

## A private instance

Kurobako forgets by design. For one that keeps things, just for you:

```sh
ITEM_TTL_SECONDS=0          # items never expire
MAX_STORAGE_BYTES=50000000000   # but never more than 50 GB in all
ACCESS_KEY=...              # 16 characters or more: only who has it gets in
```

Pages then ask for the key once (a session lasts `ACCESS_SESSION_DAYS`).
Scripts send it as `Authorization: Bearer <key>`, and `k.mjs` reads it from
`KUROBAKO_KEY`. Share links still open for anyone, one item each, unless
`PUBLIC_SHARES=false`. Add a daily backup, above, and keep it elsewhere.

## Running it

Settings are environment variables (`vars` in `wrangler.jsonc` on Cloudflare):

| Variable | Default | Notes |
| --- | ---: | --- |
| `MAX_FILE_BYTES` | `100000000` | at most 100 MB on Cloudflare Free and Pro; self-hosted has no application cap |
| `MAX_TEXT_BYTES` | `1000000` | at most 100 MB on Cloudflare Free and Pro; self-hosted has no application cap |
| `INLINE_TEXT_BYTES` | `64000` | texts above this size go to R2/S3 instead of SQLite; at most 2 MB on Cloudflare and no application cap self-hosted |
| `ITEM_TTL_SECONDS` | `86400` | `0`: no expiry; 30 days at most |
| `MAX_ITEMS` | `20` | per namespace; 1,000 at most |
| `EMPTY_NAMESPACE_TTL_SECONDS` | `3600` | before an empty namespace is deleted |
| `MAX_LIVE_CONNECTIONS` | `100` | per namespace |
| `MAX_STORAGE_BYTES` | unset | every item together, across namespaces; sends past it get `507` |
| `MISSES_PER_MINUTE` | `30` | per client: requests for namespaces, items or share links that are not there; past it, the client reads nothing for a minute. On Cloudflare, also set `MISS_LIMITER`'s limit |
| `AUTOMATED_NETWORKS` | `limit` | hosting, cloud and VPN networks and Tor, where scripts run: `allow` counts them like anyone; `limit` counts their sends and misses by network block (IPv4 /24, IPv6 /48); `block` refuses their sends (`403`). Reading is never blocked |
| `SENDS_PER_MINUTE` | `30` | per client address (an IPv6 /64 network counts as one); on Cloudflare, also set `UPLOAD_LIMITER`'s limit in `wrangler.jsonc` |
| `ADMIN_KEY` | unset | enables `/k/a`; 32 characters or more |
| `ADMIN_SESSION_HOURS` | `12` | |
| `ACCESS_KEY` | unset | makes the instance private (see "A private instance"); 16 characters or more |
| `ACCESS_SESSION_DAYS` | `30` | how long a login to a private instance lasts |
| `PUBLIC_SHARES` | `true` | in a private instance, whether share links open for anyone |
| `BASE_PATH` | unset | e.g. `/k`, to share a domain with another site: `$BOX` is then `https://example.com/k` |

Values beyond a platform's technical limits are refused at start.

**Cloudflare Workers.** Namespaces are Durable Objects and files live in a
private R2 bucket. Set `account_id`, `routes` and `bucket_name` in
`wrangler.jsonc`, optionally `bunx wrangler secret put ADMIN_KEY`, then
`bun run deploy`.

**Self-hosted.** `src/bun/server.ts` keeps one SQLite file per namespace and
larger texts and files in any S3-compatible store. Namespace databases open
lazily; the least recently used connections are closed after reaching
`SQLITE_MAX_OPEN` (default `1000`), and idle connections close after
`SQLITE_IDLE_SECONDS` (default `60`). `compose.yaml` runs it with
[Garage](https://garagehq.deuxfleurs.fr/):

```sh
ops/init-env.sh                # writes .env with fresh secrets
podman compose up -d --build   # or docker compose
```

Any other S3-compatible store works instead of Garage, such as Cloudflare
R2: set `S3_ENDPOINT` (for R2, `https://<account id>.r2.cloudflarestorage.com`),
`S3_REGION` (`auto`), `S3_BUCKET` and its keys in `.env`, and start the server
alone with `podman compose up -d --build --no-deps kurobako`. Give it a bucket
of its own as two instances sharing one would delete each other's files.

With [Nix](https://nixos.org/), the flake runs the same server without a
container, with settings from the environment (it reads no `.env`):

```sh
S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com S3_REGION=auto \
S3_BUCKET=kurobako S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... \
nix run github:merutam/kurobako
```

Or with a single-node Garage next to it, as `compose.yaml` runs, in one
command and with no S3 settings:

```sh
nix run github:merutam/kurobako#with-garage
```

`nix build` leaves the server in `./result/bin/kurobako`. It listens on
`127.0.0.1:3000` and keeps its SQLite files in `~/.local/share/kurobako`
(`$XDG_DATA_HOME/kurobako`); `HOST`, `PORT` and `DATA_DIR` change them.
`with-garage` keeps Garage's files, keys and log in `garage/` there, and
listens on `127.0.0.1:3900` and `3901` (`GARAGE_S3_PORT`, `GARAGE_RPC_PORT`).

It listens on `127.0.0.1:3000`; put a reverse proxy with HTTPS in front.
Besides the settings above it takes `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `DATA_DIR`, `PORT`,
`HOST`, `SQLITE_MAX_OPEN`, `SQLITE_IDLE_SECONDS`, `PUBLIC_URL` and, behind a
proxy, `CLIENT_IP_HEADER` (e.g. `x-forwarded-for`). Behind Cloudflare, a
Transform Rule that sets the header `cf-asn` to `ip.src.asnum` lets
`AUTOMATED_NETWORKS` tell networks apart; without it, every client counts as
a home. It logs each request and error, as one JSON line when not in a
terminal: `podman compose logs -f kurobako`.

**On NixOS.** The flake has a module, `services.kurobako`, that runs the
server as a systemd service, with Garage on the same machine if asked:

```nix
# flake.nix: inputs.kurobako.url = "github:merutam/kurobako";
imports = [ kurobako.nixosModules.default ];
services.kurobako = {
  enable = true;
  domain = "box.example"; # HTTPS through Caddy, with its certificate
  garage.enable = true; # one node; its keys, bucket and layout are made on first boot
  environmentFile = "/run/secrets/kurobako.env"; # ADMIN_KEY, ACCESS_KEY
};
```

`domain` puts Caddy in front, opens ports 80 and 443 (`openFirewall`), and
sets `PUBLIC_URL` and `CLIENT_IP_HEADER`; without it, the server answers
plain HTTP on `127.0.0.1:3000`, for a proxy of your own. Other settings go
in `settings` (`settings.MAX_ITEMS = 50;`), or with the secrets in
`environmentFile`, a `.env` as compose uses. Without `garage.enable`, set
`s3.endpoint`, `s3.region` and `s3.bucket`, and the store's keys in
`environmentFile`. The SQLite files are in `/var/lib/kurobako`.

**Replicated storage.** With `garage.mode = "cluster"`, Garage keeps
`garage.replicationFactor` copies of each file (3 by default: it reads and
writes with one node down) on as many storage nodes, in different zones
when it can. Choose the factor once, as Garage does not support changing it
later. Every machine with the server also runs a Garage node, a storage node
or a gateway (one that keeps nothing and passes requests on), and the server
talks to it alone, so no single node stops it. A storage node may run
Garage alone, with `services.kurobako.garage` set and the server left off.
On every node:

```nix
services.kurobako.garage = {
  enable = true;
  mode = "cluster";
  rpcPublicAddr = "10.0.0.1:3901";          # this node, as the others reach it
  environmentFile = "/run/secrets/garage.env"; # GARAGE_RPC_SECRET, the same on all
  openFirewall = true;                       # the RPC port, better on a private network
};
# where the server runs, its S3 key (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY):
services.kurobako.environmentFile = "/run/secrets/kurobako.env";
```

Then once, as root on any node (`garage node id` prints each node's ID;
the key is the one in the server's `environmentFile`):

```sh
garage node connect <id>@10.0.0.2:3901        # each other node
garage layout assign -z dc1 -c 500G <id>      # each storage node, its zone and size
garage layout assign -z dc1 -g <id>           # each gateway
garage layout apply --version 1
garage bucket create kurobako
garage key import -n kurobako <key id> <secret key>
garage bucket allow --read --write kurobako --key <key id>
```

Copies are no backup: a deleted file goes from every node. And the SQLite
files in `/var/lib/kurobako`, which list the items and hold short texts,
are on one machine only: back them up (`sqlite3 .backup`, or Litestream), or
keep namespace backups (`/<ns>/tar`, `/k/a/tar`).

`nix flake check` runs both setups in virtual machines (`nix/tests.nix`),
with a storage node lost along the way.

**Several servers.** Each server keeps its own data directory, and all share
one S3 store. `src/bun/router.ts` sits in front, keeps no state and sends
each namespace, with its share links and live connections, to the server
that owns it:

```sh
SERVERS=http://10.0.0.1:3000,http://10.0.0.2:3000 bun src/bun/router.ts
```

The servers run with `CLIENT_IP_HEADER=x-forwarded-for` and listen only
where the router reaches them. Every router needs the same `SERVERS`, in the
same order, and the servers' `BASE_PATH` if they have one. A server added later takes about 1/n of the namespaces; their
SQLite files must move with them. Each server limits sends on its own, and
admin logins go to the first. `/k/a` shows one server at a time, with a picker
(`/k/a?server=2`); one login works on every server sharing `ADMIN_KEY`.
`/stats.json` adds up every server's (a visitor seen by two servers counts
twice).

## Development

`nix develop` gives a shell with Bun, Node.js and Garage.

```sh
bun install
bun run dev          # wrangler dev
bun run test         # Worker tests, then the Bun server's
bun run typecheck
bun run lint         # Biome; bun run format applies its fixes
bun pm version minor # new version, in package.json and public/k.mjs
```

- `src/app.ts` puts together the routes in `src/api/`.
- `src/namespace/` and `src/hub.ts` hold the logic, on the interfaces in
  `src/platform.ts`, which `src/cloudflare/` and `src/bun/` implement.
- `src/views/*.tsx` renders every page on the server with Hono JSX, data
  included: plain namespace, shared-item, view, log and admin pages arrive
  with their initial data; encrypted pages wait for decryption in the browser.
  `public/` has browser scripts, styles and images. The protocol and the
  licenses (`src/views/templates/`) never change, so on Cloudflare
  `ops/pages.ts` renders them into `public/k/` at build time and they are
  served as static assets, without the Worker.
- `test/shared.ts` runs on both platforms.
- After changing `wrangler.jsonc`, run `bun run types`; after changing
  `assets/icon.png`, run `ops/icons.sh`.

## License

[AGPL-3.0-or-later](LICENSE). Third-party production dependencies keep their
own notices in [`LICENSES/`](LICENSES), also published at `/k/licenses` on
every instance.
