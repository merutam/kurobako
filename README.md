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

### The Bun server

It keeps one SQLite file per namespace and larger texts and files in an
S3-compatible store. Namespace databases open lazily: past `SQLITE_MAX_OPEN`
(default `1000`) the least recently used close, and idle ones close after
`SQLITE_IDLE_SECONDS` (default `60`).

It logs each request and error, as one JSON line when not in a terminal:
`podman compose logs -f kurobako`.

Behind Cloudflare, a Transform Rule that sets the header `cf-asn` to
`ip.src.asnum` lets `AUTOMATED_NETWORKS` tell networks apart; without it,
every client counts as a home.

The SQLite files list the items and hold short texts, and live on one machine
only: back them up (`sqlite3 .backup`, Litestream), or keep instance backups
(`/k/a/tar`).

### Nix

```sh
nix run github:merutam/kurobako#with-garage   # server and a local Garage
nix run github:merutam/kurobako               # server only, S3_* from the environment
```

`nix run github:merutam/kurobako` reads its settings from the environment,
never from `.env`. It listens on `127.0.0.1:3000` and keeps its SQLite files in
`$XDG_DATA_HOME/kurobako`; `HOST`, `PORT` and `DATA_DIR` change them.
`#with-garage` keeps Garage's files, keys and log in `garage/` there, on ports
`3900` and `3901` (`GARAGE_S3_PORT`, `GARAGE_RPC_PORT`). `nix build` leaves the
server in `./result/bin/kurobako`.

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

`domain` puts Caddy in front, opens ports 80 and 443 (`openFirewall`), and sets
`PUBLIC_URL` and `CLIENT_IP_HEADER`; without it, the server answers plain HTTP
on `127.0.0.1:3000`, for a proxy of your own. Other settings go in `settings`
(`settings.MAX_ITEMS = 50;`) or, with secrets, in `environmentFile`. Without
`garage.enable`, set `s3.endpoint`, `s3.region` and `s3.bucket`, and the store's
keys in `environmentFile`. The SQLite files are in `/var/lib/kurobako`.

### Cloudflare Workers

Set `account_id`, `routes` and `bucket_name` in `wrangler.jsonc`, then:

```sh
bunx wrangler secret put ADMIN_KEY   # optional
bun run deploy
```

## More than one machine

### Replicated storage

With `garage.mode = "cluster"`, Garage keeps `garage.replicationFactor` copies
of each file (3 by default: it reads and writes with one node down), in
different zones when it can. Choose the factor once: Garage cannot change it
later. Every machine with the server also runs a Garage node (a storage node or
a gateway, which keeps nothing), and the server talks to it alone, so no single
node stops it. A storage node may run Garage without the server.

On every node:

```nix
services.kurobako.garage = {
  enable = true;
  mode = "cluster";
  rpcPublicAddr = "10.0.0.1:3901";             # this node, as the others reach it
  environmentFile = "/run/secrets/garage.env"; # GARAGE_RPC_SECRET, the same on all
  openFirewall = true;                         # the RPC port, better on a private network
};
# where the server runs, its S3 key (S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY):
services.kurobako.environmentFile = "/run/secrets/kurobako.env";
```

Then once, as root on any node (`garage node id` prints each node's ID):

```sh
garage node connect <id>@10.0.0.2:3901        # each other node
garage layout assign -z dc1 -c 500G <id>      # each storage node, its zone and size
garage layout assign -z dc1 -g <id>           # each gateway
garage layout apply --version 1
garage bucket create kurobako
garage key import -n kurobako <key id> <secret key>
garage bucket allow --read --write kurobako --key <key id>
```

Copies are no backup: a deleted file goes from every node.

`nix flake check` runs both setups in virtual machines (`nix/tests.nix`), with
a storage node lost along the way.

### Several servers

Each server keeps its own data directory, and all share one S3 store. A
stateless router in front sends each namespace, with its share links and live
connections, to the server that owns it:

```sh
SERVERS=http://10.0.0.1:3000,http://10.0.0.2:3000 bun src/infrastructure/bun/router.ts
```

- The servers run with `CLIENT_IP_HEADER=x-forwarded-for` and listen only where
  the router reaches them.
- Every router needs the same `SERVERS`, in the same order, and the servers'
  `BASE_PATH` if they have one.
- A server added later takes about 1/n of the namespaces; their SQLite files
  must move with them.
- Each server limits sends on its own; admin logins go to the first.
- Set the same `INTERNAL_STATS_KEY` on the router and every backend when
  using a private instance. It permits only aggregate statistics, independently
  of `ACCESS_KEY` and `ADMIN_KEY`. The router authenticates the visitor before
  fetching private aggregates. `BASE_PATH` applies to these requests too.
- `MAX_STORAGE_BYTES` is a budget per backend, including in-flight reservations;
  it is not a cluster-wide cap.
- `/k/a` shows one server at a time (`/k/a?server=2`); one login works on every
  server sharing `ADMIN_KEY`. `/stats.json` adds up every server's.

## Settings

Environment variables (`vars` in `wrangler.jsonc` on Cloudflare). Values
beyond a platform's limits are refused at start.

| Variable | Default | Notes |
| --- | ---: | --- |
| `ITEM_TTL_SECONDS` | `86400` | `0`: never expire; 30 days at most otherwise |
| `MAX_ITEMS` | `20` | per namespace; 1,000 at most |
| `MAX_FILE_BYTES` | `100000000` | 100 MB at most on Cloudflare Free and Pro |
| `MAX_TEXT_BYTES` | `1000000` | 100 MB at most on Cloudflare Free and Pro |
| `INLINE_TEXT_BYTES` | `64000` | larger texts go to R2/S3; 300 kB at most on Cloudflare (stored escaped in a 2 MB row) |
| `MAX_STORAGE_BYTES` | unset | per backend, including in-flight reservations; sends past it get `507` |
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
bun run dev          # wrangler dev; Worker settings from wrangler.jsonc/.dev.vars
bun run start        # the Bun server
bun run test
bun run typecheck    # generates src/worker-configuration.d.ts first (bun run types)
bun run lint
```

How the code is laid out, what it guarantees, the design rules and the test
suites are in [docs/development.md](docs/development.md).

The Worker dev command ignores the self-hosted `.env`; put local Worker
secrets and overrides in `.dev.vars`. With the default Worker configuration,
the frontend opens at `http://localhost:8787/`, encrypted namespaces at `/e`,
and the admin page at `/k/a` when `ADMIN_KEY` is set in `.dev.vars`.
`BASE_PATH` in `.dev.vars` intentionally moves these pages under that prefix.

## License

[AGPL-3.0-or-later](LICENSE). Third-party notices are in [`LICENSES/`](LICENSES)
and at `/k/licenses` on every instance.
