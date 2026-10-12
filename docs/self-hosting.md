# Self-hosting in depth

The [README](../README.md) covers starting an instance. This is for running
one beyond a single machine with defaults.

## The Bun server

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

## Nix

`nix run github:merutam/kurobako` reads its settings from the environment,
never from `.env`. It listens on `127.0.0.1:3000` and keeps its SQLite files in
`$XDG_DATA_HOME/kurobako`; `HOST`, `PORT` and `DATA_DIR` change them.
`#with-garage` keeps Garage's files, keys and log in `garage/` there, on ports
`3900` and `3901` (`GARAGE_S3_PORT`, `GARAGE_RPC_PORT`). `nix build` leaves the
server in `./result/bin/kurobako`.

### NixOS

`domain` puts Caddy in front, opens ports 80 and 443 (`openFirewall`), and sets
`PUBLIC_URL` and `CLIENT_IP_HEADER`; without it, the server answers plain HTTP
on `127.0.0.1:3000`, for a proxy of your own. Other settings go in `settings`
(`settings.MAX_ITEMS = 50;`) or, with secrets, in `environmentFile`. Without
`garage.enable`, set `s3.endpoint`, `s3.region` and `s3.bucket`, and the store's
keys in `environmentFile`. The SQLite files are in `/var/lib/kurobako`.

## Replicated storage

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

## Several servers

Each server keeps its own data directory, and all share one S3 store. A
stateless router in front sends each namespace, with its share links and live
connections, to the server that owns it:

```sh
SERVERS=http://10.0.0.1:3000,http://10.0.0.2:3000 bun src/runtime/bun/router.ts
```

- The servers run with `CLIENT_IP_HEADER=x-forwarded-for` and listen only where
  the router reaches them.
- Every router needs the same `SERVERS`, in the same order, and the servers'
  `BASE_PATH` if they have one.
- A server added later takes about 1/n of the namespaces; their SQLite files
  must move with them.
- Each server limits sends on its own; admin logins go to the first.
- `/k/a` shows one server at a time (`/k/a?server=2`); one login works on every
  server sharing `ADMIN_KEY`. `/stats.json` adds up every server's.
