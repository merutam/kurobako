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
node k.mjs -O "$BOX/e#secret name"             # save every item here
```

`node k.mjs` lists everything it does. The encryption is described at
`/k/protocol` on every instance. Every instance describes itself
(base path, version, limits) at `/.well-known/kurobako`.

## Behavior

- **A namespace exists once something is sent to it**, so opening random
  names creates nothing. Once its items are gone, it is
  deleted after an hour.
- **Limits:** texts up to 256 kB, files up to 100 MB, 30 sends a minute per
  address.
- **File types** come from the bytes: PNG, JPEG, GIF, WebP, AVIF and HEIC are
  shown as images; anything else is a download.
- **Burn after reading** (`Burn: 1`): only one reader gets the item.
- **No copies:** sending contents already in a plain queue moves that item to
  the top (`200` with `"existing": true`).
- **Share links** (`/i/<token>`) open one item without revealing its
  namespace, and die with it. Encrypted ones carry the item's key after the
  `#`.
- **Live:** open pages get every change over a WebSocket.
- **Access log** at `<ns>/log`. The home page shows aggregate stats only,
  counted from page views, whose address and country are kept for a day.

## Running it

Settings are environment variables (`vars` in `wrangler.jsonc` on Cloudflare):

| Variable | Default | Notes |
| --- | ---: | --- |
| `MAX_FILE_BYTES` | `100000000` | at most 100 MB on Cloudflare Free and Pro; self-hosted has no application cap |
| `MAX_TEXT_BYTES` | `256000` | at most 100 MB on Cloudflare Free and Pro; self-hosted has no application cap |
| `INLINE_TEXT_BYTES` | `64000` | texts above this size go to R2/S3 instead of SQLite; at most 2 MB on Cloudflare and no application cap self-hosted |
| `ITEM_TTL_SECONDS` | `86400` | `0`: no expiry; 30 days at most |
| `MAX_ITEMS` | `20` | per namespace; 1,000 at most |
| `EMPTY_NAMESPACE_TTL_SECONDS` | `3600` | before an empty namespace is deleted |
| `MAX_LIVE_CONNECTIONS` | `100` | per namespace |
| `ADMIN_KEY` | unset | enables `/a`; 32 characters or more |
| `ADMIN_SESSION_HOURS` | `12` | |
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

It listens on `127.0.0.1:3000`; put a reverse proxy with HTTPS in front.
Besides the settings above it takes `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `DATA_DIR`, `PORT`,
`HOST`, `SENDS_PER_MINUTE`, `SQLITE_MAX_OPEN`, `SQLITE_IDLE_SECONDS`,
`PUBLIC_URL` and, behind a proxy,
`CLIENT_IP_HEADER` (e.g. `x-forwarded-for`). It logs each request and
error, as one JSON line when not in a terminal: `podman compose logs -f kurobako`.

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
admin logins go to the first. `/a` shows one server at a time, with a picker
(`/a?server=2`); one login works on every server sharing `ADMIN_KEY`.
`/stats.json` adds up every server's (a visitor seen by two servers counts
twice).

## Development

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
- `public/` has the pages (put in `layout.html`) and their scripts.
- `test/shared.ts` runs on both platforms.
- After changing `wrangler.jsonc`, run `bun run types`; after changing
  `assets/icon.png`, run `ops/icons.sh`.

## License

[AGPL-3.0-or-later](LICENSE). `public/vendor/uqr.js` is MIT.
