---
name: verify
description: Lint, typecheck, test and live-check trail before a commit.
---

Run from the repo root.

1. `pnpm lint && pnpm typecheck`. A lint failure on formatting or import order: `pnpm format <paths>` fixes in place (name the files you touched; a bare `pnpm format` reflows the whole tree).
2. `pnpm test` (each test file opens its own temp SQLite file; no service to start).
3. `pnpm smoke`: builds `dist/`, boots `node dist/index.js` on a throwaway database and a free port, checks `/health`, mints a key with the built `dist/cli.js`, and calls `/api/v1/projects` and `/mcp` with and without it. It catches a bad bundle, externals list or migrations copy.
4. Live check of the dev server, against one database for both the CLI and the server:
   ```sh
   export DATABASE_PATH=$(mktemp -d)/trail.db PORT=3000
   pnpm -s db:migrate   # the CLI refuses a DATABASE_PATH with no file there
   export TRAIL_BOT_KEY=$(pnpm -s trail bot create verify | awk '$1 == "key" { print $2 }')
   # own session: pnpm, sh, tsx watch and the server child all share it. The inner sh execs pnpm, so the pid it
   # writes is the session id; `setsid pnpm dev & $!` is not, because an interactive shell makes the job a group
   # leader and setsid then forks.
   DEVPID=$(mktemp)
   setsid sh -c 'echo $$ > "$1"; exec pnpm dev' sh "$DEVPID" >/dev/null 2>&1 &
   stop_dev() { pkill -s "$(cat "$DEVPID" 2>/dev/null)" 2>/dev/null; }
   trap stop_dev EXIT   # also fires when an interactive shell exits with the server still up
   curl -fsS --retry 30 --retry-delay 1 --retry-connrefused localhost:$PORT/health \
     || echo "dev server never came up on :$PORT" >&2
   ```
   Then each GET route under `/api/v1` with `curl -fsS -H "Authorization: Bearer $TRAIL_BOT_KEY" localhost:3000/api/v1<route>`: `/projects`, `/issues`, `/activity`, and with ids taken from those lists `/projects/{id}`, `/issues/{id}`, `/issues/{id}/comments`. `/api/v1/openapi.json` is the full route list and is public. Stop the server last with `stop_dev` (killing only the `pnpm dev` pid leaves tsx and the listener running), and confirm `curl localhost:$PORT/health` no longer answers.

Screenshots and logs go under `proof/`. Red → fix it before the commit; the commit waits.
