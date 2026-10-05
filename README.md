# Kurobako

A web clipboard with short queues kept apart by namespace. Open `/myns` on
your phone and on your computer to share the same box: no accounts, the 20
newest items kept, each expiring after a day.

- **Plain** (`/myns`): the server stores what is sent, and everything works
  with `curl`.
- **Encrypted** (`/e#name`): the client encrypts everything; the name, after
  the `#`, never reaches the server. Anyone with the name can read, so use a
  long one (*Random name* on the home page makes 80 bits).

It runs on Cloudflare Workers or as a self-hosted Bun server, with the same
code.

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
`/protocol` on every instance.

## Behavior

- **Nothing stored until something is sent**, so scanners leave nothing
  behind. A namespace left empty for an hour is deleted.
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
- **Access log** at `<ns>/log`; the home page shows aggregate stats only.

## Running it

Settings are environment variables (`vars` in `wrangler.jsonc` on Cloudflare):

| Variable | Default | Notes |
| --- | ---: | --- |
| `MAX_FILE_BYTES` | `100000000` | at most 100 MB on Cloudflare (its request size on the Free and Pro plans), 10 GB self-hosted |
| `MAX_TEXT_BYTES` | `256000` | at most 1 MB on Cloudflare (a text is kept in a database row, capped there at 2 MB), 16 MB self-hosted |
| `ITEM_TTL_SECONDS` | `86400` | `0`: no expiry; 30 days at most |
| `MAX_ITEMS` | `20` | per namespace; 1,000 at most |
| `EMPTY_NAMESPACE_TTL_SECONDS` | `3600` | before an empty namespace is deleted |
| `MAX_LIVE_CONNECTIONS` | `100` | per namespace |
| `ADMIN_KEY` | unset | enables `/a`; 32 characters or more |
| `ADMIN_SESSION_HOURS` | `12` | |

Larger values are refused at start.

**Cloudflare Workers.** Namespaces are Durable Objects and files live in a
private R2 bucket. Set `account_id`, `routes` and `bucket_name` in
`wrangler.jsonc`, optionally `bunx wrangler secret put ADMIN_KEY`, then
`bun run deploy`.

**Self-hosted.** `src/bun/server.ts` keeps one SQLite file per namespace and
files in any S3-compatible store. `compose.yaml` runs it with
[Garage](https://garagehq.deuxfleurs.fr/):

```sh
ops/init-env.sh                # writes .env with fresh secrets
podman compose up -d --build   # or docker compose
```

It listens on `127.0.0.1:3000`; put a reverse proxy with HTTPS in front.
Besides the settings above it takes `S3_ENDPOINT`, `S3_BUCKET`,
`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `DATA_DIR`, `PORT`,
`HOST`, `SENDS_PER_MINUTE`, `PUBLIC_URL` and, behind a proxy,
`CLIENT_IP_HEADER` (e.g. `x-forwarded-for`). It logs one JSON line per
request, and its errors, to standard output: `podman compose logs -f kurobako`.

## Development

```sh
bun install
bun run dev          # wrangler dev
bun run test         # Worker tests, then the Bun server's
bun run typecheck
bun run lint         # Biome; bun run format applies its fixes
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
