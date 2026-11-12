#!/bin/sh
# Boots the built bundle (dist/) on a throwaway database and exercises it:
# /health, the SPA's index.html and an asset of it from dist/web, a deep link falling back to index.html (JSON 404
# for an unknown /api path), a security header on a page, unauthenticated 401s on /api/v1, /api/web and /mcp, a bearer
# key minted by the built CLI on /api/v1 and /mcp, and better-auth's mount answering sign-in with no GitHub app.
# Run after `pnpm build`; `pnpm smoke` does both. Deliberately no --env-file:
# a developer's .env must not leak into the check.
set -eu
cd "$(dirname "$0")/.."

dir=$(mktemp -d)
export DATABASE_PATH="$dir/trail.db"
export TRAIL_OWNER_GITHUB=smoke-owner
# as on Fly and in the image: production-only branches run here too
export NODE_ENV=production
export BETTER_AUTH_SECRET=smoke-secret-that-is-at-least-32-characters
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

[ -f dist/web/index.html ] || { echo "dist/web/index.html missing: pnpm build must end with the SPA beside the server bundle" >&2; exit 1; }
code=$(curl -s -o "$dir/index.html" -w '%{http_code}' "$base/")
[ "$code" = 200 ] && cmp -s "$dir/index.html" dist/web/index.html || {
  echo "/ gave $code, want 200 with dist/web/index.html" >&2; exit 1;
}
asset=$(grep -o '/assets/[^"]*\.js' dist/web/index.html | head -n 1)
cache=$(curl -fsS -o /dev/null -D - "$base$asset" | tr -d '\r' | grep -i '^cache-control:' || true)
echo "$cache" | grep -q immutable || { echo "$asset gave cache header '$cache', want immutable" >&2; exit 1; }

# a page URL with a browser's Accept gets index.html; an unknown /api path stays a JSON 404
code=$(curl -s -o "$dir/deep.html" -w '%{http_code}' -H 'Accept: text/html' "$base/some/deep/link")
[ "$code" = 200 ] && cmp -s "$dir/deep.html" dist/web/index.html || {
  echo "/some/deep/link gave $code, want 200 with index.html" >&2; exit 1;
}
code=$(curl -s -o "$dir/miss.json" -w '%{http_code}' -H 'Accept: text/html' "$base/api/no-such-route")
[ "$code" = 404 ] && ! grep -q '<div id="root"' "$dir/miss.json" || {
  echo "/api/no-such-route gave $code, want a JSON 404 and not index.html" >&2; exit 1;
}
headers=$(curl -fsS -o /dev/null -D - "$base/" | tr -d '\r')
echo "$headers" | grep -qi '^content-security-policy:' || { echo "/ has no content-security-policy header" >&2; exit 1; }

key=$(node dist/cli.js bot create smoke --key-only)
[ -n "$key" ] || { echo "dist/cli.js printed no key" >&2; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/v1/projects")
[ "$code" = 401 ] || { echo "unauthenticated /api/v1/projects gave $code, want 401" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $key" "$base/api/v1/projects" >/dev/null
# /me answers a signed-out viewer, so it shows the people's API is mounted; /projects behind the member guard is the 401
curl -fsS "$base/api/web/me" | grep -q '"state":"anonymous"' || { echo "/api/web/me did not answer an anonymous viewer" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' "$base/api/web/projects")
[ "$code" = 401 ] || { echo "unauthenticated /api/web/projects gave $code, want 401" >&2; exit 1; }

# webhooks: the route and its address check are in the bundle; an internal URL is refused before anything is stored
code=$(curl -s -o "$dir/hook.json" -w '%{http_code}' -X POST "$base/api/v1/webhooks" \
  -H "Authorization: Bearer $key" -H 'Content-Type: application/json' \
  -d '{"url":"https://127.0.0.1/hook","secret":"smoke-webhook-secret-0123","projects":["NONE"]}')
[ "$code" = 404 ] || { echo "POST /api/v1/webhooks for a missing project gave $code, want 404: $(cat "$dir/hook.json")" >&2; exit 1; }
curl -fsS -H "Authorization: Bearer $key" "$base/api/v1/webhooks" | grep -q '"items":\[\]' || { echo "GET /api/v1/webhooks did not list none" >&2; exit 1; }

# /mcp loads the MCP SDK from node_modules at runtime, outside the bundle
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'
mcp() {
  curl -s -o "$dir/mcp.json" -w '%{http_code}' -X POST "$base/mcp" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    "$@" -d "$initialize"
}
code=$(mcp)
[ "$code" = 401 ] || { echo "unauthenticated /mcp gave $code, want 401" >&2; exit 1; }
code=$(mcp -H "Authorization: Bearer $key")
[ "$code" = 200 ] && grep -q '"name":"trail"' "$dir/mcp.json" || {
  echo "/mcp initialize gave $code: $(cat "$dir/mcp.json")" >&2; exit 1;
}
# no GITHUB_CLIENT_ID/SECRET here: sign-in is off, and says which variable is missing
code=$(curl -s -o "$dir/auth.json" -w '%{http_code}' -X POST "$base/api/auth/sign-in/social" \
  -H 'Content-Type: application/json' -H "Origin: $base" -d '{"provider":"github"}')
[ "$code" = 503 ] && grep -q GITHUB_CLIENT_ID "$dir/auth.json" || {
  echo "/api/auth/sign-in/social gave $code: $(cat "$dir/auth.json")" >&2; exit 1;
}
echo "smoke ok: dist boots, migrates, serves the SPA, mints a key, serves /api/v1, /api/web and /mcp, and mounts /api/auth on :$PORT"
