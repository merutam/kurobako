# Kurobako

A web clipboard with short queues kept apart by namespace. Open `/myns` on
your phone and on your computer to share the same box: no accounts, the 20
newest items kept, each expiring after a day. `/e#name` namespaces are
end-to-end encrypted.

```sh
curl -d 'hello' https://kurobako.mugens.org/myns/new   # send a text
curl -T photo.jpg https://kurobako.mugens.org/myns/    # send a file
curl https://kurobako.mugens.org/myns/1                # the newest item
```

Every instance documents its whole API, plain and encrypted, at `/k/protocol`.

## Running an instance

### Self-hosted

`compose.yaml` runs the Bun server with [Garage](https://garagehq.deuxfleurs.fr/)
for file storage:

```sh
ops/init-env.sh                # writes .env with fresh secrets
podman compose up -d --build   # or docker compose
```

It listens on `127.0.0.1:3000`: put a reverse proxy with HTTPS in front, and
set `CLIENT_IP_HEADER` (e.g. `x-forwarded-for`) so limits count real clients.

Any S3-compatible store works instead of Garage: set `S3_ENDPOINT`,
`S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in
`.env` and start the server alone with `podman compose up -d --build --no-deps kurobako`.
Give each instance a bucket of its own.

### Nix

```sh
nix run github:merutam/kurobako#with-garage   # server and a local Garage
nix run github:merutam/kurobako               # server only, S3_* from the environment
```

On NixOS, the module runs it as a service, with Caddy for HTTPS:

```nix
imports = [ kurobako.nixosModules.default ];
services.kurobako = {
  enable = true;
  domain = "box.example";
  garage.enable = true;
  environmentFile = "/run/secrets/kurobako.env"; # ADMIN_KEY, ACCESS_KEY
};
```

Replicated storage and several servers behind a router are in
[docs/self-hosting.md](docs/self-hosting.md).

### Cloudflare Workers

Set `account_id`, `routes` and `bucket_name` in `wrangler.jsonc`, then:

```sh
bunx wrangler secret put ADMIN_KEY   # optional
bun run deploy
```

## Settings

Environment variables (`vars` in `wrangler.jsonc` on Cloudflare). Values
beyond a platform's limits are refused at start.

| Variable | Default | Notes |
| --- | ---: | --- |
| `ITEM_TTL_SECONDS` | `86400` | `0`: never expire; 30 days at most otherwise |
| `MAX_ITEMS` | `20` | per namespace; 1,000 at most |
| `MAX_FILE_BYTES` | `100000000` | 100 MB at most on Cloudflare Free and Pro |
| `MAX_TEXT_BYTES` | `1000000` | 100 MB at most on Cloudflare Free and Pro |
| `INLINE_TEXT_BYTES` | `64000` | larger texts go to R2/S3; 2 MB at most on Cloudflare |
| `MAX_STORAGE_BYTES` | unset | all items together; sends past it get `507` |
| `SENDS_PER_MINUTE` | `300` | per address (an IPv6 /64 is one); on Cloudflare, also `UPLOAD_LIMITER` |
| `MISSES_PER_MINUTE` | `300` | requests for things that are not there; on Cloudflare, also `MISS_LIMITER` |
| `AUTOMATED_NETWORKS` | `limit` | hosting, VPN and Tor networks: `allow`, `limit` (count per network block) or `block` sends |
| `ADMIN_KEY` | unset | enables `/k/a`; 32 characters or more |
| `ACCESS_KEY` | unset | makes the instance private; 16 characters or more |
| `PUBLIC_SHARES` | `true` | in a private instance, whether share links still open |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | unset | push notifications; `bun ops/vapid.ts` makes the pair (keep it) |
| `BASE_PATH` | unset | e.g. `/k`, to share a domain with another site |

Also: `EMPTY_NAMESPACE_TTL_SECONDS`, `MAX_LIVE_CONNECTIONS`,
`ADMIN_SESSION_HOURS`, `ACCESS_SESSION_DAYS`, `MAX_PUSH_SUBSCRIPTIONS`,
`VAPID_SUBJECT`; and, self-hosted only, `DATA_DIR`, `HOST`, `PORT`,
`PUBLIC_URL`, `SQLITE_MAX_OPEN` and `SQLITE_IDLE_SECONDS`.

### A private instance

For one that keeps things, just for you:

```sh
ITEM_TTL_SECONDS=0
MAX_STORAGE_BYTES=50000000000
ACCESS_KEY=...
```

Scripts send the key as `Authorization: Bearer <key>`.

### Backups

With `ADMIN_KEY` set, the whole instance comes out as a tar or zip and goes
back the same way; encrypted items stay encrypted:

```sh
curl -H "Authorization: Bearer $ADMIN_KEY" -o backup.tar https://box.example/k/a/tar
curl -H "Authorization: Bearer $ADMIN_KEY" -T backup.tar https://box.example/k/a/import
```

On Cloudflare, requests are capped at 100 MB: `/k/protocol` shows how to back
up in parts.

## Development

`nix develop` gives a shell with Bun, Node.js and Garage.

```sh
bun install
bun run dev          # wrangler dev
bun run start        # the Bun server
bun run test
bun run typecheck
bun run lint
```

## License

[AGPL-3.0-or-later](LICENSE). Third-party notices are in [`LICENSES/`](LICENSES)
and at `/k/licenses` on every instance.
