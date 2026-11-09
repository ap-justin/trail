#!/bin/sh
# Starts trail under Litestream when a backup bucket is configured (on Fly),
# or as plain node otherwise (local runs, CI's boot test).
set -eu
if [ -n "${BUCKET_NAME:-}" ]; then
  exec litestream replicate -config /etc/litestream.yml
fi
if [ -n "${FLY_APP_NAME:-}" ]; then
  echo "WARNING: BUCKET_NAME is not set; trail is running without Litestream backup" >&2
fi
exec node --enable-source-maps /app/dist/index.js
