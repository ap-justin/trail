#!/bin/sh
# Boots the built bundle (dist/) on a throwaway database and exercises it:
# /health, an unauthenticated 401, and a bearer key minted by the built CLI.
# Run after `pnpm build`; `pnpm smoke` does both. Deliberately no --env-file:
# a developer's .env must not leak into the check.
set -eu
cd "$(dirname "$0")/.."

dir=$(mktemp -d)
export DATABASE_PATH="$dir/trail.db"
PORT=$(node -e 'const s=require("node:net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')
export PORT
base="http://127.0.0.1:$PORT"

node dist/index.js >"$dir/server.log" 2>&1 &
pid=$!
cleanup() {
  status=$?
  kill "$pid" 2>/dev/null || true
  if [ "$status" -ne 0 ]; then
    echo "smoke failed; server log:" >&2
    cat "$dir/server.log" >&2
  fi
  rm -rf "$dir"
  exit "$status"
}
trap cleanup EXIT

up=
for _ in $(seq 50); do
  if curl -fsS "$base/health" >/dev/null 2>&1; then up=1; break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
[ -n "$up" ] || { echo "server never answered /health" >&2; exit 1; }

key=$(node dist/cli.js bot create smoke | awk '$1 == "key" { print $2 }')
[ -n "$key" ] || { echo "dist/cli.js printed no key" >&2; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/v1/projects")
[ "$code" = 401 ] || { echo "unauthenticated /api/v1/projects gave $code, want 401" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $key" "$base/api/v1/projects" >/dev/null
echo "smoke ok: dist boots, migrates, mints a key and serves /api/v1 on :$PORT"
