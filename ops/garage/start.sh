#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Kurobako contributors

# Starts Garage and, the first time, gives it a layout, the bucket and the
# app's access key.
set -eu
: "${GARAGE_RPC_SECRET:?run ops/init-env.sh first}" "${S3_BUCKET:?}"
: "${S3_ACCESS_KEY_ID:?run ops/init-env.sh first}" "${S3_SECRET_ACCESS_KEY:?run ops/init-env.sh first}"

garage server &
server=$!
trap 'kill -TERM "$server"; wait "$server"' TERM INT

until garage status >/dev/null 2>&1; do sleep 1; done

if ! garage bucket info "$S3_BUCKET" >/dev/null 2>&1; then
  node=$(garage node id -q | cut -d@ -f1)
  garage layout assign -z local -c "${GARAGE_CAPACITY:-100G}" "$node" >/dev/null
  garage layout apply --version 1 >/dev/null
  garage bucket create "$S3_BUCKET" >/dev/null
fi
if ! garage key info "$S3_ACCESS_KEY_ID" >/dev/null 2>&1; then
  garage key import --yes -n app "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
fi
garage bucket allow --read --write "$S3_BUCKET" --key "$S3_ACCESS_KEY_ID" >/dev/null
echo "Garage is ready: bucket $S3_BUCKET."

wait "$server"
