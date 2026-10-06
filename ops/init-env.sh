#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors

# Writes a .env for compose.yaml with fresh secrets.
set -eu
target=${1:-.env}
if [ -e "$target" ]; then
  echo "$target already exists; not touching it." >&2
  exit 1
fi
# $1 random bytes, as twice as many hex characters: hex 32 gives 64.
hex() { od -An -vtx1 -N"$1" /dev/urandom | tr -d ' \n'; }
umask 077
cat >"$target" <<ENV
# Settings for compose.yaml (see .env.example for every option).
PORT=3000

# Garage, which compose.yaml runs next to the server.
GARAGE_RPC_SECRET=$(hex 32)
S3_ACCESS_KEY_ID=GK$(hex 12)
S3_SECRET_ACCESS_KEY=$(hex 32)
# Or another S3-compatible store, such as Cloudflare R2: put its keys above,
# uncomment these, and start with: podman compose up -d --build --no-deps kurobako
# S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com
# S3_REGION=auto
# S3_BUCKET=kurobako

# At least 32 characters; leave empty to disable /a.
ADMIN_KEY=$(hex 24)
# A private instance, just for you: uncomment, and only who has it gets in.
# ACCESS_KEY=$(hex 16)
CLIENT_IP_HEADER=
ENV
echo "Wrote $target."
