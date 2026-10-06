# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors

# The server and a single-node Garage for its files, outside of containers
# for `nix run .#with-garage` (flake.nix puts garage and kurobako on PATH).
# Everything lives in DATA_DIR: the server's SQLite files,
# and Garage's in DATA_DIR/garage, with the keys it was given the
# first time. Garage's own log goes to DATA_DIR/garage/garage.log.

data_dir="${DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/kurobako}"
garage_dir="$data_dir/garage"
s3_port="${GARAGE_S3_PORT:-3900}"
rpc_port="${GARAGE_RPC_PORT:-3901}"
mkdir -p "$garage_dir"

# $1 random bytes, as twice as many hex characters.
hex() { od -An -vtx1 -N"$1" /dev/urandom | tr -d ' \n'; }

# Fresh secrets the first time, kept for the next.
secrets="$garage_dir/secrets.env"
if [ ! -e "$secrets" ]; then
  (
    umask 077
    cat >"$secrets" <<ENV
GARAGE_RPC_SECRET=$(hex 32)
S3_ACCESS_KEY_ID=GK$(hex 12)
S3_SECRET_ACCESS_KEY=$(hex 32)
ENV
  )
fi
# shellcheck source=/dev/null
. "$secrets"

cat >"$garage_dir/garage.toml" <<TOML
metadata_dir = "$garage_dir/meta"
data_dir = "$garage_dir/data"
db_engine = "sqlite"
replication_factor = 1

rpc_bind_addr = "127.0.0.1:$rpc_port"
rpc_public_addr = "127.0.0.1:$rpc_port"

[s3_api]
s3_region = "garage"
api_bind_addr = "127.0.0.1:$s3_port"
TOML

export GARAGE_CONFIG_FILE="$garage_dir/garage.toml" GARAGE_RPC_SECRET
GARAGE_DEFAULT_BUCKET=kurobako \
  GARAGE_DEFAULT_ACCESS_KEY="$S3_ACCESS_KEY_ID" \
  GARAGE_DEFAULT_SECRET_KEY="$S3_SECRET_ACCESS_KEY" \
  garage server --single-node --default-bucket >>"$garage_dir/garage.log" 2>&1 &
garage=$!
trap 'kill "$garage" 2>/dev/null; wait "$garage" 2>/dev/null' EXIT

until garage bucket info kurobako >/dev/null 2>&1; do
  if ! kill -0 "$garage" 2>/dev/null; then
    echo "Garage did not start; see $garage_dir/garage.log:" >&2
    tail -n 20 "$garage_dir/garage.log" >&2
    exit 1
  fi
  sleep 1
done
echo "Garage is ready on 127.0.0.1:$s3_port, in $garage_dir."

export DATA_DIR="$data_dir" S3_ENDPOINT="http://127.0.0.1:$s3_port" S3_REGION=garage \
  S3_BUCKET=kurobako S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
# Not exec: Garage stops when the server does.
kurobako "$@"
